import type { z } from 'zod';
import type { ProvideLinksToolSchema } from './intelligent-support/schemas';

const ZENDESK_API_BASE_URL = process.env.ZENDESK_API_BASE_URL || '';

const myHeaders = new Headers();
myHeaders.append('Content-Type', 'application/json');
myHeaders.append('Accept', 'application/json');
myHeaders.append(
  'Authorization',
  `Basic ${Buffer.from(`${process.env.ZENDESK_CONVERSATION_API_KEY_ID}:${process.env.ZENDESK_CONVERSATION_API_SECRET}`).toString('base64')}`
);

export interface ZendeskMessage {
  id: string;
  received: string;
  author: {
    userId?: string;
    displayName?: string;
    avatarUrl?: string;
    type: 'user' | 'business';
  };
  content: {
    type: string;
    text: string;
  };
  source: {
    integrationId?: string;
    type: string;
  };
}

export const serializeLinks = (links: z.infer<typeof ProvideLinksToolSchema>['links'] | null | undefined) => {
  const introSourcesBlurb = 'Sources:';
  if (!links || links.length === 0) {
    return introSourcesBlurb;
  }
  const deduplicatedLinks = links.reduce((accumulator, currentLink) => {
    const currentUrl = currentLink.url;
    const currentTitle = currentLink.title ?? 'Untitled';
    if (!currentUrl) return accumulator;
    const existingByUrl = accumulator.find(link => link.url === currentUrl);
    if (existingByUrl) {
      const existingTitle = existingByUrl.title ?? 'Untitled';
      if (currentTitle.length < existingTitle.length) {
        const index = accumulator.indexOf(existingByUrl);
        accumulator[index] = { ...currentLink, title: currentTitle };
      }
    } else {
      const existingByTitle = accumulator.find(link => (link.title ?? 'Untitled') === currentTitle);
      if (existingByTitle) {
        if (currentUrl.length < existingByTitle.url.length) {
          const index = accumulator.indexOf(existingByTitle);
          accumulator[index] = { ...currentLink, title: currentTitle };
        }
      } else {
        accumulator.push({ ...currentLink, title: currentTitle });
      }
    }
    return accumulator;
  }, [] as NonNullable<typeof links>);
  const sources = deduplicatedLinks.map(link => `%[${link.title ?? 'Untitled'}](${link.url})`).join('\n');
  return [introSourcesBlurb, sources].join('\n');
};

const sendMessageToZendesk = async (conversationId: string, message: string, authorDisplayName: string, authorAvatarUrl: string) => {
  const cleanedMessage = message.replace(/%?\[\(\d+\)\]\([^)]+\)/g, '');
  const raw = JSON.stringify({
    author: {
      type: 'business',
      displayName: authorDisplayName,
      avatarUrl: authorAvatarUrl
    },
    content: {
      type: 'text',
      text: cleanedMessage
    }
  });
  const url = new URL(`${ZENDESK_API_BASE_URL}/apps/${process.env.ZENDESK_CONVERSATION_API_APP_ID}/conversations/${conversationId}/messages`);
  const response = await fetch(url.toString(), { method: 'POST', headers: myHeaders, body: raw });
  const data = await response.json();
  return data;
};

export const makeBotSender = (aiAssistantName: string, aiAssistantAvatarUrl: string, conversationId: string) => {
  return (message: string) => sendMessageToZendesk(conversationId, message, aiAssistantName, aiAssistantAvatarUrl);
};

export const makeHumanSender = (conversationId: string) => {
  return (message: string) => sendMessageToZendesk(conversationId, message, 'Joe', 'https://gravatar.com/avatar/27205e5c51cb03f862138b22bcb5dc20f94a342e744ff6df1b8dc8af3c865109?s=200');
};

export const passControl = async (appId: string, conversationId: string) => {
  console.log('Passing control to agent...', process.env.ZENDESK_CONVERSATION_API_AGENTWORKSPACE_SWITCHBOARD_INTEGRATION_ID);

  const response = await fetch(`${ZENDESK_API_BASE_URL}/apps/${appId}/conversations/${conversationId}/passControl`, {
    method: 'POST',
    headers: myHeaders,
    body: JSON.stringify({
      switchboardIntegration: process.env.ZENDESK_CONVERSATION_API_AGENTWORKSPACE_SWITCHBOARD_INTEGRATION_ID,
    }),
  });

  if (!response.ok) {
    const errorData = await response.text();
    console.error('Agent handoff failed:', errorData);
    throw new Error('Agent handoff failed.');
  }

  return await response.json();
};


export type ZendeskActivityEvent = 'conversation:read' | 'typing:start' | 'typing:stop';

export const postActivity = async (appId: string, conversationId: string, event: ZendeskActivityEvent) => {
  const raw = JSON.stringify({ author: { type: 'business' }, type: event });
  const response = await fetch(`${ZENDESK_API_BASE_URL}/apps/${appId}/conversations/${conversationId}/activity`, {
    method: 'POST',
    headers: myHeaders,
    body: raw
  });
  return await response.text();
};

export const getMessages = async (appId: string, conversationId: string, pageAfter?: string, pageSize = 50): Promise<{ messages: ZendeskMessage[]; meta: { hasMore: boolean } }> => {
  const url = new URL(`${ZENDESK_API_BASE_URL}/apps/${appId}/conversations/${conversationId}/messages`);
  if (pageAfter) url.searchParams.append('page[after]', pageAfter);
  url.searchParams.append('page[size]', pageSize.toString());
  const response = await fetch(url.toString(), { headers: myHeaders });
  return await response.json();
};

export const getAllMessages = async (appId: string, conversationId: string, pageSize = 50): Promise<ZendeskMessage[]> => {
  let allMessages: ZendeskMessage[] = [];
  let pageAfter: string | undefined;
  let hasMore = true;
  while (hasMore) {
    const data = await getMessages(appId, conversationId, pageAfter, pageSize);
    allMessages = [...allMessages, ...data.messages];
    hasMore = data.meta.hasMore;
    if (hasMore && data.messages.length > 0) {
      pageAfter = data.messages[data.messages.length - 1].id;
    }
  }
  return allMessages;
};

// Create ticket fallback
// Ensure correct Zendesk Support API credentials here
const createZendeskTicket = async (userMessage: string, conversationId: string) => {
  const SUPPORT_API_URL = `https://${process.env.ZENDESK_SUPPORT_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`;

  const SUPPORT_API_HEADERS = new Headers();
  SUPPORT_API_HEADERS.append('Content-Type', 'application/json');
  SUPPORT_API_HEADERS.append('Accept', 'application/json');
  SUPPORT_API_HEADERS.append(
    'Authorization',
    `Basic ${Buffer.from(`${process.env.ZENDESK_SUPPORT_EMAIL}/token:${process.env.ZENDESK_SUPPORT_API_TOKEN}`).toString('base64')}`
  );

  const ticketBody = {
    ticket: {
      subject: `Live Chat Support Needed (Conversation ID: ${conversationId})`,
      comment: {
        body: `Customer message:\n\n${userMessage}\n\nConversation ID: ${conversationId}`
      },
      priority: "normal"
    }
  };

  const response = await fetch(SUPPORT_API_URL, {
    method: 'POST',
    headers: SUPPORT_API_HEADERS,
    body: JSON.stringify(ticketBody)
  });

  const data = await response.json();
  console.log('Zendesk Ticket Created:', data);
  return data;
};


// Fallback handler: handoff + fallback to ticket

// Fallback if no agent accepts the handover
export const handleAgentHandoffWithFallback = async (
  appId: string,
  conversationId: string,
  userMessage: string,
  aiAssistantName: string,
  aiAssistantAvatarUrl: string
) => {
  const botSender = makeBotSender(aiAssistantName, aiAssistantAvatarUrl, conversationId);

  try {
    const passControlResponse = await passControl(appId, conversationId);

    if (passControlResponse?.success) {
      await botSender("Let me connect you to a live agent. Please hold...");
    } else {
      throw new Error('No agent accepted the chat.');
    }
  } catch (error) {
    console.error('Agent handoff failed:', error);

    await botSender("Our support agents are currently unavailable. A support ticket has been created for you.");
    await createZendeskTicket(userMessage, conversationId);  // This must be correct now
  }
};

