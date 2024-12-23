import 'server-only';
import { ProvideAIAnnotationsToolSchema, ProvideLinksToolSchema } from './schemas';

import type { CoreMessage } from 'ai';
import type { z } from 'zod';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { ProvideRecordsConsideredToolSchema } from './schemas';
import type { ZendeskMessage } from '../zendeskConversations';
import { systemPrompt } from './prompts';

const inkeepModel = 'inkeep-qa-expert';

export const generateQaModeResponse = async ({
  messages,
  metadata,
  supportApiKey,
}: {
  messages: ZendeskMessage[];
  metadata?: Record<string, string>;
  supportApiKey?: string;
}) => {
  console.log('metadata', metadata);
  const openai = createOpenAI({
    apiKey: supportApiKey || process.env.AUTO_RESPONDER_INKEEP_API_KEY,
    baseURL: 'https://api.inkeep.com/v1',
  });

  const formattedMessages = [
    {
      role: 'system',
      content: systemPrompt,
    },
    ...messages.map(
      message =>
        ({
          role: message.author.type === 'user' ? 'user' : 'assistant',
          content: message.content.text,
        }) as CoreMessage,
    ),
  ];
  console.log(formattedMessages);
  const { text, toolCalls } = await generateText({
    model: openai(inkeepModel),
    messages: formattedMessages as CoreMessage[],
    tools: {
      provideRecordsConsidered: {
        parameters: ProvideRecordsConsideredToolSchema,
      },
      provideAIAnnotations: {
        parameters: ProvideAIAnnotationsToolSchema,
      },
      provideLinks: {
        parameters: ProvideLinksToolSchema,
      },
    },
    toolChoice: 'auto',
    // experimental_telemetry: {
    //   isEnabled: true,
    //   functionId: 'generateQaModeResponse',
    //   metadata: {
    //     isAutoResponder: true,
    //     ...(metadata ?? {}),
    //   },
    // },
  });

  const aiAnnotations = toolCalls.find(toolCall => toolCall.toolName === 'provideAIAnnotations')?.args
    .aiAnnotations as z.infer<typeof ProvideAIAnnotationsToolSchema>['aiAnnotations'];
  const recordsConsidered = toolCalls.find(toolCall => toolCall.toolName === 'provideRecordsConsidered')?.args
    .recordsConsidered as z.infer<typeof ProvideRecordsConsideredToolSchema>['recordsConsidered'];
  const links = toolCalls.find(toolCall => toolCall.toolName === 'provideLinks')?.args.links as z.infer<
    typeof ProvideLinksToolSchema
  >['links'];

  return {
    aiAnnotations,
    text,
    recordsConsidered,
    links,
  };
};
