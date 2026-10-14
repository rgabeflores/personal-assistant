export const config = {
  chatBaseUrl: (process.env.EXPO_PUBLIC_CHAT_BASE_URL ?? "").replace(/\/$/, ""),
  cognitoDomain: (process.env.EXPO_PUBLIC_COGNITO_DOMAIN ?? "").replace(/\/$/, ""),
  cognitoClientId: process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID ?? "",
  devSkipAuth: __DEV__ && process.env.EXPO_PUBLIC_DEV_SKIP_AUTH === "true",
};
