export interface WebhookPayload {
  app: {
    id: string;
  };
  webhook: {
    id: string;
    version: string;
  };
  events: Array<{
    id: string;
    createdAt: string;
    type: string;
    payload: {
      conversation: {
        id: string;
        type: string;
        brandId: string;
        activeSwitchboardIntegration: {
          id: string;
          name: string;
          integrationId: string;
          integrationType: string;
        };
      };
      message?: {
        id: string;
        received: string;
        author: {
          userId: string;
          displayName: string;
          type: string;
          user: {
            id: string;
            profile: {
              locale: string;
              localeOrigin: string;
            };
            signedUpAt: string;
            metadata: Record<string, unknown>;
            identities: unknown[];
          };
        };
        content: {
          type: string;
          text: string;
        };
        source: {
          integrationId: string;
          type: string;
          device: {
            id: string;
            guid: string;
            clientId: string;
            integrationId: string;
            type: string;
            status: string;
            info: {
              vendor: string;
              sdkVersion: string;
              URL: string;
              userAgent: string;
              referrer: string;
              browserLanguage: string;
              currentUrl: string;
              currentTitle: string;
              ipAddress: string;
              country: string;
              countryCode: string;
              state: string;
              stateCode: string;
              city: string;
            };
            lastSeen: string;
          };
        };
      };
    };
  }>;
}
