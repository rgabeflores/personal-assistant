import { randomUUID } from "expo-crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ApiError, createConversation, sendMessage, warmChat } from "../lib/api";
import { useAuth } from "../lib/auth";
import { colors } from "../lib/theme";
import type { ActionCard } from "../lib/types";

type Item = {
  key: string;
  role: "user" | "assistant";
  text: string;
  cards: ActionCard[];
  state: "sending" | "streaming" | "complete" | "failed";
  statusLabel?: string;
  clientMessageId?: string;
  error?: string;
};

export function ChatScreen() {
  const { getAccessToken, signOut } = useAuth();
  const [items, setItems] = useState<Item[]>([]);
  const [draft, setDraft] = useState("");
  const [title, setTitle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const conversation = useRef<{ id: string } | null>(null);
  const conversationKey = useRef(randomUUID());
  const list = useRef<FlatList<Item>>(null);

  useEffect(() => warmChat(), []);

  const patch = (key: string, fn: (i: Item) => Item) => setItems((all) => all.map((i) => (i.key === key ? fn(i) : i)));

  const run = useCallback(
    async (text: string, clientMessageId: string, userKey: string) => {
      const assistantKey = `a-${clientMessageId}`;
      setBusy(true);
      setItems((all) => [
        ...all.filter((i) => i.key !== assistantKey),
        { key: assistantKey, role: "assistant", text: "", cards: [], state: "sending" },
      ]);
      try {
        // New chat creates nothing until the first send (api/README.md, Conversations and history).
        conversation.current ??= await createConversation(getAccessToken, conversationKey.current);
        for await (const ev of sendMessage(getAccessToken, conversation.current.id, { client_message_id: clientMessageId, text })) {
          switch (ev.type) {
            case "status":
              patch(assistantKey, (i) => ({ ...i, statusLabel: ev.label }));
              break;
            case "text.delta":
              patch(assistantKey, (i) => ({ ...i, state: "streaming", statusLabel: undefined, text: i.text + ev.text }));
              break;
            case "card":
              patch(assistantKey, (i) => ({ ...i, cards: [...i.cards, ev.card] }));
              break;
            case "turn.completed": {
              // The completed message is authoritative; it replaces the streamed draft.
              const text = ev.message.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n");
              const cards = ev.message.blocks.flatMap((b) => (b.type === "action_card" ? [b.card] : []));
              patch(assistantKey, (i) => ({ ...i, key: ev.message.id, text, cards, state: "complete", statusLabel: undefined }));
              patch(userKey, (i) => ({ ...i, state: "complete" }));
              setTitle(ev.conversation.title);
              break;
            }
            case "error":
              throw new ApiError(0, ev.error.code, ev.error.message, ev.error.retryable);
          }
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return signOut();
        const message = err instanceof ApiError ? err.message : "Couldn't reach the assistant.";
        setItems((all) => all.filter((i) => i.key !== assistantKey));
        patch(userKey, (i) => ({ ...i, state: "failed", error: message }));
      } finally {
        setBusy(false);
      }
    },
    [getAccessToken, signOut],
  );

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    const clientMessageId = randomUUID();
    const key = `u-${clientMessageId}`;
    setDraft("");
    setItems((all) => [...all, { key, role: "user", text, cards: [], state: "sending", clientMessageId }]);
    void run(text, clientMessageId, key);
  };

  // Retry reuses the same client_message_id, so a turn that already finished is replayed, not re-run.
  const retry = (item: Item) => {
    if (busy || !item.clientMessageId) return;
    patch(item.key, (i) => ({ ...i, state: "sending", error: undefined }));
    void run(item.text, item.clientMessageId, item.key);
  };

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {title ?? "New chat"}
        </Text>
      </View>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <FlatList
          ref={list}
          style={styles.flex}
          contentContainerStyle={styles.list}
          data={items}
          keyExtractor={(i) => i.key}
          onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
          ListEmptyComponent={<Text style={styles.empty}>Try "Log 45 minutes of capoeira".</Text>}
          renderItem={({ item }) => <Bubble item={item} onRetry={() => retry(item)} />}
        />
        <View style={styles.composer}>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            onFocus={warmChat}
            placeholder="Message"
            placeholderTextColor={colors.muted}
            multiline
            accessibilityLabel="Message"
          />
          <Pressable style={[styles.send, (!draft.trim() || busy) && styles.sendDisabled]} onPress={send} accessibilityRole="button" accessibilityLabel="Send">
            <Text style={styles.sendText}>↑</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Bubble({ item, onRetry }: { item: Item; onRetry: () => void }) {
  if (item.role === "user") {
    return (
      <View style={styles.userWrap}>
        <View style={[styles.userBubble, item.state === "failed" && styles.failed]}>
          <Text style={styles.userText}>{item.text}</Text>
        </View>
        {item.state === "failed" && (
          <Pressable onPress={onRetry} accessibilityRole="button">
            <Text style={styles.retry}>{item.error} Retry</Text>
          </Pressable>
        )}
      </View>
    );
  }
  const thinking = item.state === "sending" && !item.text;
  return (
    <View style={styles.assistantWrap}>
      {thinking && <Text style={styles.muted}>{item.statusLabel ?? "…"}</Text>}
      {!!item.text && <Text style={styles.assistantText}>{item.text}</Text>}
      {item.cards.map((c) => (
        <View key={c.id} style={styles.card}>
          <Text style={styles.cardKind}>{c.kind === "log_entry" ? "Logged" : c.kind}</Text>
          {!!c.spoken_caption && <Text style={styles.cardText}>{c.spoken_caption}</Text>}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  header: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  headerTitle: { fontSize: 17, fontWeight: "600", color: colors.text, textAlign: "center" },
  list: { padding: 16, gap: 12, flexGrow: 1 },
  empty: { color: colors.muted, textAlign: "center", marginTop: 48 },
  userWrap: { alignItems: "flex-end", gap: 4 },
  userBubble: { backgroundColor: colors.userBubble, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, maxWidth: "85%" },
  failed: { opacity: 0.6 },
  userText: { color: "#fff", fontSize: 16 },
  retry: { color: colors.danger, fontSize: 13 },
  assistantWrap: { alignItems: "flex-start", gap: 8, maxWidth: "90%" },
  assistantText: { color: colors.text, fontSize: 16, lineHeight: 22 },
  muted: { color: colors.muted, fontSize: 14 },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, gap: 4, alignSelf: "stretch" },
  cardKind: { color: colors.accent, fontWeight: "600", fontSize: 13 },
  cardText: { color: colors.text, fontSize: 15 },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, padding: 12, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  input: { flex: 1, minHeight: 40, maxHeight: 120, backgroundColor: colors.surface, borderRadius: 20, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, color: colors.text },
  send: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  sendDisabled: { opacity: 0.4 },
  sendText: { color: "#fff", fontSize: 20, fontWeight: "700" },
});
