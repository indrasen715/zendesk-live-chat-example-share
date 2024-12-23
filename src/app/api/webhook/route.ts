import { NextResponse } from 'next/server';
import { kv } from '@vercel/kv';

import type { WebhookPayload } from '../../../schemas/WebhookPayload'; // Assuming we move the interface to a separate file

import dotenv from 'dotenv';
import {
  passControl,
  postActivity,
  getAllMessages,
  makeBotSender,
  makeHumanSender,
  serializeLinks,
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

async function sendHumanHandoffMessageSequence(
  appId: string,
  conversationId: string,
  humanMessageSender: (message: string) => Promise<void>,
) {
  await delay(2000);
  await postActivity(appId, conversationId, 'typing:start');
  await delay(3321);
  await postActivity(appId, conversationId, 'typing:stop');
  await humanMessageSender('Hi, I am Joe. Taking a look at this question, will get back to you shortly.');
  await delay(1567);
  await postActivity(appId, conversationId, 'typing:start');
  await delay(4099);
  await postActivity(appId, conversationId, 'typing:stop');
  await humanMessageSender(
    "I'm still investigating, I'll send you a message when I find out more. I created Ticket #56 to track this issue.",
  );
}

async function handleEvent(body: WebhookPayload) {
  // The KV store is used to debounce events to prevent duplicate processing
  const eventId = body.events[0].id;
  const eventIdKey = `processed_event:${eventId}`;
  // Check if the event has already been processed
  if (await kv.get<boolean>(eventIdKey)) {
    return `Event ${eventId} has already been processed. Skipping.`;
  }
  // Track that we are currently processing this event
  await kv.set(eventIdKey, true, { ex: 1000 });

  if (body.events.length !== 1) {
    console.warn('Received a webhook with an unexpected number of events', body.events.length);
  }

  // Destructure the body and event content
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
  /// brandId can be used to maintain multiple implementations of the messenger.
  //Contact inkeep support if you need help in configuring zendesk to use a different brandId.

  const authorType = message?.author?.type;
  const messageContent = message?.content?.text;

  // Validate the event type
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
  const sendHumanMessage = makeHumanSender(conversationId);

  if (containsEscalationPhrase(messageContent)) {
    // Skip AI response and pass control to human agent
    await sendBotMessage('Connecting you to a support agent. Please hold on.');
    await passControl(appId, conversationId);
    return `Escalation phrase detected: ${messageContent}`;
  }

  try {
    await postActivity(appId, conversationId, 'conversation:read');
  } catch (e) {
    console.error('Error posting conversation:read, but fire and forget allowed', e);
  }

  const messages = await getAllMessages(appId, conversationId);

  // Check if the conversation is new
  const isNewConversation = messages.length === 1 && messages[0].author.type === 'user';

  // Start generating the QA response in parallel
  const generateResponsePromise = generateQaModeResponse({
    messages,
  });

  if (isNewConversation) {
    // Simulate typing
    await postActivity(appId, conversationId, 'typing:start');
    await delay(1000);
    await postActivity(appId, conversationId, 'typing:stop');

    // Send initial message
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
      await sendBotMessage("I'm not too sure about this question, I'm looping in the support team to take a look.");
      await sendHumanHandoffMessageSequence(appId, conversationId, sendHumanMessage);
      await passControl(appId, conversationId);
    }
  } catch (error) {
    console.error('Error generating QA response:', error);
    await postActivity(appId, conversationId, 'typing:stop');
    // Handle the error, possibly pass control to a human agent
    await sendBotMessage("I'm sorry, I encountered an error. I'm passing you over to a support agent.");
    await sendHumanHandoffMessageSequence(appId, conversationId, sendHumanMessage);
    await passControl(appId, conversationId);
    return 'Error generating QA response';
  }
}

async function handleWebhook(request: Request) {
  try {
    let result = { message: 'Request received', data: {} };

    if (request.method === 'POST') {
      // Parse the JSON body from the request
      const body = await request.json();
      const resultMessage = await handleEvent(body);
      console.dir(body, { depth: null });
      console.log(resultMessage);
      result = {
        message: resultMessage ?? 'POST request received',
        data: { success: true },
      };
    }

    // Return a JSON response
    return NextResponse.json({ result }, { status: 200 });
  } catch (error) {
    // Handle any errors
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
