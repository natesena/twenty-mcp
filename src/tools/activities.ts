import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TwentyClient } from '../client/twenty-client.js';

export function registerActivityTools(server: McpServer, client: TwentyClient) {
  server.tool(
    'get_activities',
    'Get unified activities timeline from Twenty CRM (tasks, notes, etc.)',
    {
      type: z.array(z.enum(['task', 'note'])).optional().describe('Filter by activity types'),
      dateFrom: z.string().optional().describe('Start date filter (ISO 8601 format)'),
      dateTo: z.string().optional().describe('End date filter (ISO 8601 format)'),
      authorId: z.string().optional().describe('Filter by author/assignee ID'),
      limit: z.number().optional().default(20).describe('Maximum number of activities to return'),
      offset: z.number().optional().default(0).describe('Number of activities to skip'),
    },
    async (args) => {
      try {
        const timeline = await client.getActivities({
          type: args.type,
          dateFrom: args.dateFrom,
          dateTo: args.dateTo,
          authorId: args.authorId,
          limit: args.limit,
          offset: args.offset,
        });

        const activitiesText = timeline.activities.map(activity => {
          const authorName = activity.author 
            ? `${activity.author.name.firstName} ${activity.author.name.lastName}`
            : 'Unknown';
          
          const createdDate = new Date(activity.createdAt).toLocaleDateString();
          
          return `[${activity.type.toUpperCase()}] ${activity.title || 'Untitled'} (${createdDate})
Author: ${authorName}
${activity.body ? `Content: ${activity.body.substring(0, 200)}${activity.body.length > 200 ? '...' : ''}` : ''}
ID: ${activity.id}
---`;
        }).join('\n\n');

        return {
          content: [{
            type: 'text' as const,
            text: `Activities Timeline (${timeline.totalCount} total, showing ${timeline.activities.length}):

${activitiesText}

${timeline.hasMore ? 'Use offset parameter to load more activities.' : 'No more activities to load.'}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error retrieving activities: ${error instanceof Error ? error.message : 'Unknown error'}`
          }]
        };
      }
    }
  );

  server.tool(
    'filter_activities',
    'Filter activities by specific criteria',
    {
      type: z.string().optional().describe('Activity type to filter: "task" or "note"'),
      dateFrom: z.string().optional().describe('Start date (ISO 8601 format)'),
      dateTo: z.string().optional().describe('End date (ISO 8601 format)'),
      authorId: z.string().optional().describe('Filter by author/assignee ID'),
      status: z.string().optional().describe('Task status filter: TODO, IN_PROGRESS, or DONE'),
      limit: z.number().optional().default(20).describe('Maximum number of results'),
      offset: z.number().optional().default(0).describe('Number of results to skip'),
    },
    async (args) => {
      try {
        const activities = await client.filterActivities({
          type: args.type ? [args.type as 'task' | 'note'] : undefined,
          dateFrom: args.dateFrom,
          dateTo: args.dateTo,
          authorId: args.authorId,
          status: args.status ? [args.status] : undefined,
          limit: args.limit,
          offset: args.offset,
        });

        if (activities.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: 'No activities found matching the specified criteria.'
            }]
          };
        }

        const resultsText = activities.map((activity, index) => {
          const authorName = activity.author 
            ? `${activity.author.name.firstName} ${activity.author.name.lastName}`
            : 'Unknown';
          
          return `${index + 1}. [${activity.type.toUpperCase()}] ${activity.title || 'Untitled'}
   Created: ${new Date(activity.createdAt).toLocaleString()}
   Author: ${authorName}
   ID: ${activity.id}`;
        }).join('\n\n');

        return {
          content: [{
            type: 'text' as const,
            text: `Found ${activities.length} activities matching criteria:

${resultsText}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error filtering activities: ${error instanceof Error ? error.message : 'Unknown error'}`
          }]
        };
      }
    }
  );

  server.tool(
    'create_comment',
    'Create a comment/note in CRM',
    {
      body: z.string().describe('Comment content (markdown)'),
      title: z.string().optional().describe('Optional title for the note'),
    },
    async (args) => {
      try {
        const comment = await client.createComment({
          body: args.body,
        });

        return {
          content: [{
            type: 'text' as const,
            text: `Note created successfully (ID: ${comment.id})\n\nContent: ${comment.body}\nCreated: ${new Date(comment.createdAt).toLocaleString()}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error creating comment: ${error instanceof Error ? error.message : 'Unknown error'}`
          }]
        };
      }
    }
  );

  server.tool(
    'get_entity_activities',
    'Get all activities related to a specific entity (person, company, or opportunity)',
    {
      entityId: z.string().describe('ID of the entity'),
      entityType: z.enum(['person', 'company', 'opportunity']).describe('Type of entity'),
      includeComments: z.boolean().optional().default(true).describe('Include comments in results'),
      limit: z.number().optional().default(20).describe('Maximum number of activities'),
      offset: z.number().optional().default(0).describe('Number of activities to skip'),
    },
    async (args) => {
      try {
        const timeline = await client.getEntityActivities({
          entityId: args.entityId,
          entityType: args.entityType,
          includeComments: args.includeComments,
          limit: args.limit,
          offset: args.offset,
        });

        if (timeline.activities.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `No activities found for ${args.entityType} ${args.entityId}.`
            }]
          };
        }

        const activitiesText = timeline.activities.map((activity, index) => {
          const authorName = activity.author 
            ? `${activity.author.name.firstName} ${activity.author.name.lastName}`
            : 'Unknown';
          
          const date = new Date(activity.createdAt);
          
          return `${index + 1}. [${activity.type.toUpperCase()}] ${activity.title || 'Untitled'}
   Created: ${date.toLocaleDateString()} at ${date.toLocaleTimeString()}
   Author: ${authorName}
   ${activity.body ? `Preview: ${activity.body.substring(0, 150)}${activity.body.length > 150 ? '...' : ''}` : ''}`;
        }).join('\n\n');

        return {
          content: [{
            type: 'text' as const,
            text: `Activities for ${args.entityType} ${args.entityId} (${timeline.totalCount} total):

${activitiesText}

${timeline.hasMore ? `Use offset=${args.offset! + args.limit!} to load more activities.` : 'No more activities available.'}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error retrieving entity activities: ${error instanceof Error ? error.message : 'Unknown error'}`
          }]
        };
      }
    }
  );
}