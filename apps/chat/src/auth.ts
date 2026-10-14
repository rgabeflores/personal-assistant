import { CognitoJwtVerifier } from "aws-jwt-verify";

export type Identity = { sub: string };
export type Authenticate = (authorization: string | undefined) => Promise<Identity | null>;

/**
 * The Function URL is public (AuthType NONE), so every request is verified here before any work
 * (chat-service.md §5). The verifier caches the user pool's JWKS across invocations.
 */
export function cognitoAuthenticator(userPoolId: string, clientId: string): Authenticate {
  const verifier = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: "access" });
  return async (authorization) => {
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return null;
    try {
      const payload = await verifier.verify(token);
      return { sub: payload.sub };
    } catch {
      return null;
    }
  };
}

/** Warms the JWKS cache at module load so the first real request skips the fetch. */
export async function hydrateJwks(userPoolId: string, clientId: string): Promise<void> {
  await CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: "access" }).hydrate();
}
