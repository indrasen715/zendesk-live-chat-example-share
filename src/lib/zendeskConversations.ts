import type { z } from 'zod';
import type { ProvideLinksToolSchema } from './intelligent-support/schemas';

const ZENDESK_API_BASE_URL = process.env.ZENDESK_API_BASE_URL || '';
const ZENDESK_CONVERSATION_API_KEY_ID = process.env.ZENDESK_CONVERSATION_API_KEY_ID || '';
const myHeaders = new Headers();
myHeaders.append('Content-Type', 'application/json');
myHeaders.append('Accept', 'application/json');
myHeaders.append(
  'Authorization',
  `Basic ${Buffer.from(`${process.env.ZENDESK_CONVERSATION_API_KEY_ID}:${process.env.ZENDESK_CONVERSATION_API_SECRET}`).toString('base64')}`,
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

  const deduplicatedLinks = links.reduce(
    (accumulator, currentLink) => {
      const currentUrl = currentLink.url;
      const currentTitle = currentLink.title ?? 'Untitled';

      if (!currentUrl) {
        return accumulator;
      }

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
    },
    [] as NonNullable<typeof links>,
  );

  const sources = deduplicatedLinks
    .map(link => {
      const title = link.title ?? 'Untitled';
      const url = link.url;
      return `%[${title}](${url})`;
    })
    .join('\n');

  return [introSourcesBlurb, sources].join('\n');
};

const sendMessageToZendesk = async (
  conversationId: string,
  message: string,
  authorDisplayName: string,
  authorAvatarUrl: string,
) => {
  console.log('sending message to zendesk', conversationId, message);

  const cleanedMessage = message.replace(/%?\[\(\d+\)\]\([^)]+\)/g, '');

  const raw = JSON.stringify({
    author: {
      type: 'business',
      displayName: authorDisplayName,
      avatarUrl: authorAvatarUrl,
    },
    content: {
      type: 'text',
      text: cleanedMessage,
    },
  });

  const requestOptions = {
    method: 'POST',
    headers: myHeaders,
    body: raw,
  };

  const url = new URL(
    `${ZENDESK_API_BASE_URL}/apps/${process.env.ZENDESK_CONVERSATION_API_APP_ID}/conversations/${conversationId}/messages`,
  );

  console.log('url', url.toString());

  const response = await fetch(url.toString(), requestOptions);
  console.log('response', response.status, response.statusText);
  const data = await response.json();
  console.log('data', data);
  return data;
};

export const makeBotSender = (aiAssistantName: string, aiAssistantAvatarUrl: string, conversationId: string) => {
  return (message: string) => {
    return sendMessageToZendesk(conversationId, message, aiAssistantName, aiAssistantAvatarUrl);
  };
};

export const makeHumanSender = (conversationId: string) => {
  return (message: string) => {
    return sendMessageToZendesk(
      conversationId,
      message,
      'Joe',
      'https://gravatar.com/avatar/27205e5c51cb03f862138b22bcb5dc20f94a342e744ff6df1b8dc8af3c865109?s=200',
    );
  };
};

export const passControl = async (appId: string, conversationId: string) => {
  console.log('passControl', appId, conversationId);
  const response = await fetch(`${ZENDESK_API_BASE_URL}/apps/${appId}/conversations/${conversationId}/passControl`, {
    method: 'POST',
    headers: myHeaders,
    body: JSON.stringify({
      switchboardIntegration: process.env.ZENDESK_CONVERSATION_API_AGENTWORKSPACE_SWITCHBOARD_INTEGRATION_ID,
    }),
  });
  const data = await response.json();
  return data;
};

export type ZendeskActivityEvent = 'conversation:read' | 'typing:start' | 'typing:stop';

export const postActivity = async (appId: string, conversationId: string, event: ZendeskActivityEvent) => {
  console.log('postActivity', event, appId, conversationId);
  const raw = JSON.stringify({
    author: {
      type: 'business',
    },
    type: event,
  });

  const requestOptions = {
    method: 'POST',
    headers: myHeaders,
    body: raw,
  };

  const response = await fetch(
    `${ZENDESK_API_BASE_URL}/apps/${appId}/conversations/${conversationId}/activity`,
    requestOptions,
  );
  const data = await response.text();
  return data;
};

export const getMessages = async (
  appId: string,
  conversationId: string,
  pageAfter?: string,
  pageSize = 50,
): Promise<{ messages: ZendeskMessage[]; meta: { hasMore: boolean } }> => {
  const url = new URL(`${ZENDESK_API_BASE_URL}/apps/${appId}/conversations/${conversationId}/messages`);

  if (pageAfter) {
    url.searchParams.append('page[after]', pageAfter);
  }
  url.searchParams.append('page[size]', pageSize.toString());

  const response = await fetch(url.toString(), {
    headers: myHeaders,
  });
  const data = await response.json();
  return data;
};

export const getAllMessages = async (
  appId: string,
  conversationId: string,
  pageSize = 50,
): Promise<ZendeskMessage[]> => {
  let allMessages: ZendeskMessage[] = [];

  let pageAfter: string | undefined;
  let hasMore = true;

  while (hasMore) {
    console.log('getting messages page', appId, conversationId, pageAfter, pageSize);
    const data = await getMessages(appId, conversationId, pageAfter, pageSize);
    allMessages = [...allMessages, ...data.messages];
    hasMore = data.meta.hasMore;

    if (hasMore && data.messages.length > 0) {
      pageAfter = data.messages[data.messages.length - 1].id;
    }
  }

  return allMessages;
};


/** --- ADDED: Intelligent live-chat handler with fallback to agent & ticket creation --- **/

// Example: Dummy bot answer logic (replace with real AI model call)
const getBotAnswer = async (userMessage: string): Promise<string | null> => {
  if (userMessage.toLowerCase().includes("hours")) {
    return "Our working hours are 9 AM to 5 PM, Monday to Friday.";
  }
  return null;
};

// Create Zendesk support ticket (fallback option)
const createZendeskTicket = async (userMessage: string, conversationId: string) => {
  const ticketBody = {
    ticket: {
      subject: `Support needed from Chat: ${conversationId}`,
      comment: {
        body: `Customer message: ${userMessage}\nConversation ID: ${conversationId}`
      },
      priority: "normal"
    }
  };

  const response = await fetch(`${ZENDESK_API_BASE_URL}/tickets.json`, {
    method: 'POST',
    headers: myHeaders,
    body: JSON.stringify(ticketBody)
  });

  const data = await response.json();
  console.log('Created Zendesk Ticket:', data);
  return data;
};

// Main handler: Bot or human fallback
export const handleChatResponse = async (
  conversationId: string,
  userMessage: string,
  aiAssistantName: string,
  aiAssistantAvatarUrl: string
) => {
  const botSender = makeBotSender(aiAssistantName, aiAssistantAvatarUrl, conversationId);
  const humanSender = makeHumanSender(conversationId);

  const botReply = await getBotAnswer(userMessage);  // Replace with real AI logic

  if (botReply) {
    await botSender(botReply);
  } else {
    await humanSender("I'm connecting you to a live agent. Please hold...");
    await passControl(ZENDESK_CONVERSATION_API_KEY_ID, conversationId);
    await createZendeskTicket(userMessage, conversationId);  // Optional fallback
  }
};
/** --- END of Added Section --- **/
