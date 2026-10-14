import { exchangeCodeAsync, makeRedirectUri, refreshAsync, useAuthRequest, type DiscoveryDocument } from "expo-auth-session";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { config } from "./config";

WebBrowser.maybeCompleteAuthSession();

type Tokens = { accessToken: string; refreshToken?: string; expiresAt: number };
type AuthState = {
  status: "loading" | "signedOut" | "signedIn";
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  /** A valid access token, refreshed if needed; null when signed out. */
  getAccessToken: () => Promise<string | null>;
};

const STORE_KEY = "auth.tokens";
const AuthContext = createContext<AuthState | null>(null);

const discovery: DiscoveryDocument = {
  authorizationEndpoint: `${config.cognitoDomain}/oauth2/authorize`,
  tokenEndpoint: `${config.cognitoDomain}/oauth2/token`,
  revocationEndpoint: `${config.cognitoDomain}/oauth2/revoke`,
};
const redirectUri = makeRedirectUri({ scheme: "assistant", path: "auth" });

async function save(tokens: Tokens | null) {
  if (tokens) await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(tokens));
  else await SecureStore.deleteItemAsync(STORE_KEY);
}

/** Cognito hosted UI with PKCE (api/README.md §2). Tokens live in the secure store. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState["status"]>(config.devSkipAuth ? "signedIn" : "loading");
  const tokens = useRef<Tokens | null>(null);
  const [request, , promptAsync] = useAuthRequest(
    { clientId: config.cognitoClientId, redirectUri, scopes: ["openid", "email", "profile"], usePKCE: true },
    discovery,
  );

  useEffect(() => {
    if (config.devSkipAuth) return;
    SecureStore.getItemAsync(STORE_KEY).then((raw) => {
      tokens.current = raw ? (JSON.parse(raw) as Tokens) : null;
      setStatus(tokens.current ? "signedIn" : "signedOut");
    });
  }, []);

  const signIn = useCallback(async () => {
    if (!request) return;
    const result = await promptAsync();
    if (result.type !== "success") return;
    const res = await exchangeCodeAsync(
      { clientId: config.cognitoClientId, code: result.params.code!, redirectUri, extraParams: { code_verifier: request.codeVerifier! } },
      discovery,
    );
    tokens.current = { accessToken: res.accessToken, refreshToken: res.refreshToken, expiresAt: Date.now() + (res.expiresIn ?? 3600) * 1000 };
    await save(tokens.current);
    setStatus("signedIn");
  }, [request, promptAsync]);

  const signOut = useCallback(async () => {
    tokens.current = null;
    await save(null);
    setStatus("signedOut");
  }, []);

  const getAccessToken = useCallback(async () => {
    if (config.devSkipAuth) return null;
    const t = tokens.current;
    if (!t) return null;
    if (t.expiresAt - Date.now() > 60_000) return t.accessToken;
    if (!t.refreshToken) {
      await signOut();
      return null;
    }
    try {
      const res = await refreshAsync({ clientId: config.cognitoClientId, refreshToken: t.refreshToken }, discovery);
      tokens.current = { accessToken: res.accessToken, refreshToken: res.refreshToken ?? t.refreshToken, expiresAt: Date.now() + (res.expiresIn ?? 3600) * 1000 };
      await save(tokens.current);
      return tokens.current.accessToken;
    } catch {
      await signOut();
      return null;
    }
  }, [signOut]);

  const value = useMemo(() => ({ status, signIn, signOut, getAccessToken }), [status, signIn, signOut, getAccessToken]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
