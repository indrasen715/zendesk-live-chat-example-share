import { NextResponse } from 'next/server';
import { kv } from '@vercel/kv';

import type { WebhookPayload } from '../../../schemas/WebhookPayload';

import dotenv from 'dotenv';
import {
  postActivity,
  getAllMessages,
  makeBotSender,
  serializeLinks,
  handleAgentHandoffWithFallback
} from '../../../lib/zendeskConversations';

import { generateQaModeResponse } from '../../../lib/intelligent-support/support';

dotenv.config();

export const maxDuration = 300;

function containsEscalationPhrase(message: string): boolean {
  const keyPhrases = ['talk to support', 'talk to human', 'talk human', 'skip ai'];
  const lowerCaseMessage = message.toLowerCase();
  return keyPhrases.some(phrase => lowerCaseMessage.includes(phrase));
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function handleEvent(body: WebhookPayload) {
  const eventId = body.events[0].id;
  const eventIdKey = `processed_event:${eventId}`;

  if (await kv.get<boolean>(eventIdKey)) {
    return `Event ${eventId} has already been processed. Skipping.`;
  }

  await kv.set(eventIdKey, true, { ex: 1000 });

  if (body.events.length !== 1) {
    console.warn('Received a webhook with an unexpected number of events', body.events.length);
  }

  const {
    app: { id: appId },
  } = body;

  const event = body.events[0];

  const {
    payload: {
      conversation: { id: conversationId, brandId },
      message,
    },
    type: eventType,
  } = event;

  console.log('messenger brandId', brandId);

  const authorType = message?.author?.type;
  const messageContent = message?.content?.text;

  if (eventType !== 'conversation:message') {
    return `Ignoring eventType: ${eventType}`;
  }

  if (authorType !== 'user') {
    return `Ignoring non-user message: ${authorType}`;
  }

  if (!messageContent) {
    return 'Unexpected message without content';
  }

  const aiAssistantName = process.env.AI_ASSISTANT_NAME || 'AI Agent';
  const aiAssistantAvatarUrl = process.env.AI_ASSISTANT_AVATAR_URL || '';

  const sendBotMessage = makeBotSender(aiAssistantName, aiAssistantAvatarUrl, conversationId);

  if (containsEscalationPhrase(messageContent)) {
    await sendBotMessage('Connecting you to a support agent. Please hold on.');
    await handleAgentHandoffWithFallback(appId, conversationId, messageContent, aiAssistantName, aiAssistantAvatarUrl);
    return `Escalation phrase detected: ${messageContent}`;
  }

  try {
    await postActivity(appId, conversationId, 'conversation:read');
  } catch (e) {
    console.error('Error posting conversation:read, but fire and forget allowed', e);
  }

  const messages = await getAllMessages(appId, conversationId);
  const isNewConversation = messages.length === 1 && messages[0].author.type === 'user';

  const generateResponsePromise = generateQaModeResponse({ messages });

  if (isNewConversation) {
    await postActivity(appId, conversationId, 'typing:start');
    await delay(1000);
    await postActivity(appId, conversationId, 'typing:stop');
    await sendBotMessage('Hi there, let me check my knowledge base to see if I can help with that.');
  }

  await delay(300);
  await postActivity(appId, conversationId, 'typing:start');

  try {
    const result = await generateResponsePromise;
    await postActivity(appId, conversationId, 'typing:stop');

    const acceptableConfidenceLevels = ['very_confident', 'somewhat_confident'];

    if (acceptableConfidenceLevels.includes(result.aiAnnotations.answerConfidence)) {
      await sendBotMessage(result.text.trim());
      await sendBotMessage(serializeLinks(result.links));
    } else {
      await sendBotMessage("I'm not too sure about this question, let me connect you to our support team.");
      await handleAgentHandoffWithFallback(appId, conversationId, messageContent, aiAssistantName, aiAssistantAvatarUrl);
    }
  } catch (error) {
    console.error('Error generating QA response:', error);
    await postActivity(appId, conversationId, 'typing:stop');
    await sendBotMessage("I'm sorry, I encountered an error. Let me connect you to our support team.");
    await handleAgentHandoffWithFallback(appId, conversationId, messageContent, aiAssistantName, aiAssistantAvatarUrl);
    return 'Error generating QA response';
  }
}

async function handleWebhook(request: Request) {
  try {
    let result = { message: 'Request received', data: {} };

    if (request.method === 'POST') {
      const body = await request.json();
      const resultMessage = await handleEvent(body);
      console.dir(body, { depth: null });
      console.log(resultMessage);
      result = {
        message: resultMessage ?? 'POST request received',
        data: { success: true },
      };
    }

    return NextResponse.json({ result }, { status: 200 });
  } catch (error) {
    console.error(`Error processing ${request.method} request:`, error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return await handleWebhook(request);
}

export async function HEAD(request: Request) {
  return await handleWebhook(request);
}
