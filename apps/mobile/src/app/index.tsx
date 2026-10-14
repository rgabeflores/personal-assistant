import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { ChatScreen } from "../components/ChatScreen";
import { useAuth } from "../lib/auth";
import { colors } from "../lib/theme";

// Phase 1: sign-in, then a single chat screen. Tabs (Today, Log, Insights, …) arrive in later phases.
export default function Index() {
  const { status, signIn } = useAuth();

  if (status === "loading") {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (status === "signedOut") {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Assistant</Text>
        <Pressable style={styles.button} onPress={signIn} accessibilityRole="button">
          <Text style={styles.buttonText}>Continue</Text>
        </Pressable>
      </View>
    );
  }

  return <ChatScreen />;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 24, backgroundColor: colors.background },
  title: { fontSize: 28, fontWeight: "600", color: colors.text },
  button: { backgroundColor: colors.accent, paddingHorizontal: 32, paddingVertical: 14, borderRadius: 12 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
