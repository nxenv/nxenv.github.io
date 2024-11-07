import { IResolvers } from '@graphql-tools/utils';
import { traceResolvers } from './trace';
import { AuthContext, BaseContext, Context } from '../Context';
import {
  getSessions,
  postFeedback,
  SearchResultFeedback,
  Search,
  getSession,
  SearchSession,
} from '../integrations';
import { ValidationError } from 'apollo-server-errors';
import { GQLEmptyResponse, meiliOffsetGenerator } from './common';
import { Connection as ConnectionRelay } from 'graphql-relay/connection/connection';
import graphorm from '../graphorm';
import { ConnectionArguments } from 'graphql-relay/index';
import {
  FeedArgs,
  feedResolver,
  fixedIdsFeedBuilder,
  ghostUser,
} from '../common';
import { GQLPost } from './posts';
import { MeiliPagination, searchMeili } from '../integrations/meilisearch';
import { Keyword, Post, Source, UserPost } from '../entity';
import {
  SearchSuggestionArgs,
  defaultSearchLimit,
  getSearchLimit,
} from '../common/search';
import { getOffsetWithDefault } from 'graphql-relay';
import { Brackets } from 'typeorm';
import { whereVordrFilter } from '../common/vordr';
import { ContentPreference } from '../entity/contentPreference/ContentPreference';
import { ContentPreferenceType } from '../entity/contentPreference/types';

type GQLSearchSession = Pick<SearchSession, 'id' | 'prompt' | 'createdAt'>;

interface GQLSearchSuggestion {
  id: string;
  title: string;
  subtitle?: string;
  image?: string;
  contentPreference?: ContentPreference;
}

export interface GQLSearchSuggestionsResults {
  query: string;
  hits: GQLSearchSuggestion[];
}

export const typeDefs = /* GraphQL */ `
  type SearchSession {
    id: String!
    prompt: String!
    createdAt: DateTime!
  }

  type SearchSessionEdge {
    node: SearchSession!

    """
    Used in \`before\` and \`after\` args
    """
    cursor: String!
  }

  type SearchSessionConnection {
    pageInfo: PageInfo!
    edges: [SearchSessionEdge!]!
  }

  type SearchChunkError {
    message: String
    code: String
  }

  type SearchChunkSource {
    id: String!
    name: String!
    snippet: String!
    url: String!
  }

  type SearchChunk {
    id: String!
    prompt: String!
    response: String!
    error: SearchChunkError
    createdAt: DateTime!
    completedAt: DateTime!
    feedback: Int
    sources: [SearchChunkSource]
  }

  type Search {
    id: String!
    createdAt: DateTime!
    chunks: [SearchChunk]
  }

  type SearchSuggestion {
    id: String!
    title: String!
    subtitle: String
    image: String
    contentPreference: ContentPreference
  }

  type SearchSuggestionsResults {
    query: String!
    hits: [SearchSuggestion!]!
  }

  extend type Query {
    """
    Get user's search history
    """
    searchSessionHistory(
      """
      Paginate after opaque cursor
      """
      after: String

      """
      Paginate first
      """
      first: Int
    ): SearchSessionConnection! @auth

    """
    Get a search session by id
    """
    searchSession(id: String!): Search! @auth

    """
    Get suggestions for search post query
    """
    searchPostSuggestions(
      """
      The query to search for
      """
      query: String!

      """
      Version of the search algorithm
      """
      version: Int = 2
    ): SearchSuggestionsResults!

    """
    Get a posts feed of a search query
    """
    searchPosts(
      """
      The query to search for
      """
      query: String!

      """
      Time the pagination started to ignore new items
      """
      now: DateTime

      """
      Paginate after opaque cursor
      """
      after: String

      """
      Paginate first
      """
      first: Int

      """
      Array of supported post types
      """
      supportedTypes: [String!]

      """
      Version of the search algorithm
      """
      version: Int = 2
    ): PostConnection!

    """
    Get tags for search tags query
    """
    searchTagSuggestions(
      """
      The query to search for
      """
      query: String!

      """
      Maximum number of tags to return
      """
      limit: Int = ${defaultSearchLimit}

      """
      Version of the search algorithm
      """
      version: Int = 2
    ): SearchSuggestionsResults!

    """
    Get sources for search sources query
    """
    searchSourceSuggestions(
      """
      The query to search for
      """
      query: String!

      """
      Maximum number of sources to return
      """
      limit: Int = ${defaultSearchLimit}

      """
      Version of the search algorithm
      """
      version: Int = 2
    ): SearchSuggestionsResults!

    """
    Get users for search users query
    """
    searchUserSuggestions(
      """
      The query to search for
      """
      query: String!

      """
      Maximum number of users to return
      """
      limit: Int = ${defaultSearchLimit}

      """
      Whether to include content preference status in the search
      """
      includeContentPreference: Boolean = false

      """
      Version of the search algorithm
      """
      version: Int = 2
    ): SearchSuggestionsResults!
  }

  extend type Mutation {
    """
    Send a feedback regarding the search result
    """
    searchResultFeedback(chunkId: String!, value: Int!): EmptyResponse! @auth
  }
`;

const meiliSearchResolver = feedResolver(
  (
    ctx,
    { ids }: FeedArgs & { ids: string[]; pagination: MeiliPagination },
    builder,
    alias,
  ) => fixedIdsFeedBuilder(ctx, ids, builder, alias),
  meiliOffsetGenerator(),
  (ctx, args, page, builder) => builder,
  {
    removeHiddenPosts: true,
    removeBannedPosts: false,
    allowPrivatePosts: false,
  },
);

export const resolvers: IResolvers<unknown, BaseContext> = traceResolvers<
  unknown,
  BaseContext
>({
  Query: {
    searchSessionHistory: async (
      _,
      args: ConnectionArguments,
      ctx: AuthContext,
    ): Promise<ConnectionRelay<GQLSearchSession>> => {
      const { first, after } = args;

      return graphorm.queryPaginatedIntegration(
        () => !!after,
        (nodeSize) => nodeSize === first,
        (node) => node.id,
        () =>
          getSessions(ctx.userId, {
            limit: first || undefined,
            lastId: after || undefined,
          }),
      );
    },
    searchSession: async (
      _,
      { id }: { id: string },
      ctx: AuthContext,
    ): Promise<Search> => getSession(ctx.userId, id),
    searchPostSuggestions: async (
      source,
      { query, version }: { query: string; version: number },
      ctx: Context,
    ): Promise<GQLSearchSuggestionsResults> => {
      const searchParams = new URLSearchParams({
        q: query,
        attributesToRetrieve: 'post_id,title',
      });
      if (version === 2) {
        searchParams.append('attributesToSearchOn', 'title');
      }
      const { hits } = await searchMeili(searchParams.toString());
      // In case ids is empty make sure the query does not fail
      const idsStr = hits.length
        ? hits.map((id) => `'${id.post_id}'`).join(',')
        : `'nosuchid'`;
      let newBuilder = ctx.con
        .createQueryBuilder()
        .select('post.id, post.title')
        .from(Post, 'post')
        .innerJoin(
          Source,
          'source',
          'source.id = post.sourceId AND source.private = false AND source.id != :sourceId',
          { sourceId: 'unknown' },
        )
        .where('post.id IN (:...ids)', {
          ids: hits.length ? hits.map((x) => x.post_id) : ['nosuchid'],
        })
        .andWhere('post.title IS NOT NULL')
        .orderBy(`array_position(array[${idsStr}], post.id)`);
      if (ctx.userId) {
        newBuilder = newBuilder
          .leftJoin(
            UserPost,
            'userpost',
            `userpost."postId" = "post".id AND userpost."userId" = :userId AND userpost.hidden = TRUE`,
            { userId: ctx.userId },
          )
          .andWhere('userpost."postId" IS NULL');
      }
      const cleanHits = await newBuilder.getRawMany();

      return {
        query,
        hits: cleanHits,
      };
    },
    searchPosts: async (
      source,
      args: FeedArgs & {
        query: string;
        version: number;
        first: number;
        after: string;
      },
      ctx: Context,
      info,
    ): Promise<ConnectionRelay<GQLPost> & { query: string }> => {
      const limit = Math.min(args.first || 10);
      const offset = getOffsetWithDefault(args.after, -1) + 1;
      const searchParams = new URLSearchParams({
        q: args.query,
        limit: limit.toString(),
        offset: offset.toString(),
      });
      if (args.version === 2) {
        searchParams.append('attributesToSearchOn', 'title');
      }
      const meilieSearchRes = await searchMeili(searchParams.toString());
      const meilieArgs: FeedArgs & {
        ids: string[];
        pagination: MeiliPagination;
      } = {
        ...args,
        ids: meilieSearchRes.hits.map((x) => x.post_id),
        pagination: meilieSearchRes.pagination,
      };

      const res = await meiliSearchResolver(source, meilieArgs, ctx, info);
      return {
        ...res,
        query: args.query,
      };
    },
    searchTagSuggestions: async (
      source,
      { query, limit }: SearchSuggestionArgs,
      ctx,
    ): Promise<GQLSearchSuggestionsResults> => {
      const searchQuery = ctx.con
        .getRepository(Keyword)
        .createQueryBuilder()
        .select(`value as id, COALESCE(flags->>'title', value) as title`)
        .where(`status = 'allow'`)
        .andWhere(`value ILIKE :query`, {
          query: `%${query}%`,
        })
        .orderBy(`occurrences`, 'DESC')
        .limit(getSearchLimit({ limit }));
      const hits = await searchQuery.getRawMany();

      return {
        query,
        hits,
      };
    },
    searchSourceSuggestions: async (
      source,
      { query, limit }: SearchSuggestionArgs,
      ctx,
    ): Promise<GQLSearchSuggestionsResults> => {
      const searchQuery = ctx.con
        .getRepository(Source)
        .createQueryBuilder()
        .select(`id, name as title, handle as subtitle, image`)
        .where(`private = false`)
        .andWhere(`name ILIKE :query`, {
          query: `%${query}%`,
        })
        .limit(getSearchLimit({ limit }));
      const hits = await searchQuery.getRawMany();

      return {
        query,
        hits,
      };
    },
    searchUserSuggestions: async (
      source,
      { query, limit, includeContentPreference }: SearchSuggestionArgs,
      ctx: Context,
    ): Promise<GQLSearchSuggestionsResults> => {
      if (!query || query.length < 3 || query.length > 100) {
        return {
          query,
          hits: [],
        };
      }
      const searchQuery = ctx.con
        .createQueryBuilder()
        .select(`id, name as title, username as subtitle, image`)
        .from('user', 'u')
        .where('u.infoConfirmed = TRUE')
        .andWhere(`u.id != :ghostId`, { ghostId: ghostUser.id })
        .andWhere(
          new Brackets((qb) => {
            return qb
              .where(`name ILIKE :query`, {
                query: `%${query}%`,
              })
              .orWhere(`username ILIKE :query`, {
                query: `%${query}%`,
              });
          }),
        );
      if (includeContentPreference && ctx.userId) {
        searchQuery.addSelect((contentPreferenceQueryBuilder) => {
          return contentPreferenceQueryBuilder
            .select('to_json(res)')
            .from((subQuery) => {
              return subQuery
                .select('*')
                .from(ContentPreference, 'cp')
                .where('cp."referenceId" = u.id')
                .andWhere('cp."type" = :cpType', {
                  cpType: ContentPreferenceType.User,
                })
                .andWhere('cp."userId" = :cpUserId', {
                  cpUserId: ctx.userId,
                });
            }, 'res');
        }, 'contentPreference');
      }
      searchQuery
        .orderBy('u.reputation', 'DESC')
        .andWhere(whereVordrFilter('u'))
        .limit(getSearchLimit({ limit: Math.max(limit || 0, 10) }));
      const hits = await searchQuery.getRawMany();
      return {
        query,
        hits: hits.slice(0, limit),
      };
    },
  },
  Mutation: {
    searchResultFeedback: async (
      _,
      { chunkId, value }: SearchResultFeedback,
      ctx: AuthContext,
    ): Promise<GQLEmptyResponse> => {
      if (value > 1 || value < -1) {
        throw new ValidationError('Invalid value');
      }

      await postFeedback(ctx.userId, { chunkId, value });

      return { _: true };
    },
  },
});