use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientFrame {
    Register { username: String, display_name: String, password: String },
    Login { username: String, password: String },
    Resume { token: String },
    Logout,
    SearchUsers { query: String },
    CreateConversation { other_uid: String },
    ListConversations,
    UpdateProfile { display_name: String, about: String },
    ConversationHistory { conversation_id: String, before: Option<String> },
    Offer { sdp: String },
    IceCandidate { candidate: serde_json::Value },
    PublishPrekeys { bundle: serde_json::Value },
    GetPrekeyBundle { uid: String },
    CallSignal { to_uid: String, payload: serde_json::Value },
    CallState { call_id: Option<String> },
    DataFrame { payload: serde_json::Value },
    ChatThemes { id: Option<String> },
    Ping,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerFrame {
    AuthOk { uid: String, username: String, display_name: String, about: String, token: String },
    LoggedOut,
    Users { users: Vec<UserSummary> },
    Conversation { conversation_id: String, user: UserSummary },
    Conversations { conversations: Vec<ConversationSummary> },
    ProfileUpdated { user: UserSummary },
    History { conversation_id: String, messages: Vec<MessageEnvelope> },
    PrekeysPublished,
    PrekeyBundle { uid: String, bundle: serde_json::Value },
    Error { code: String, message: String },
    ChatThemes { themes: serde_json::Value },
    Pong,
    Answer { sdp: String },
    IceCandidate { candidate: serde_json::Value },
    CallSignal { from_uid: String, payload: serde_json::Value },
    DataFrame { payload: serde_json::Value },
}

#[derive(Debug, Clone, Serialize)]
pub struct UserSummary {
    pub uid: String,
    pub username: String,
    pub display_name: String,
    pub about: String,
    pub online: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConversationSummary {
    pub conversation_id: String,
    pub user: UserSummary,
    pub updated_at: String,
    pub unread_count: i64,
    pub has_messages: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageEnvelope {
    pub message_id: String,
    pub conversation_id: String,
    pub sender_uid: String,
    pub ciphertext_b64: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub msg_type: Option<u8>,
    pub created_at: String,
    pub status: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DataChannelClientFrame {
    SendMessage {
        message_id: String,
        conversation_id: String,
        #[serde(default)]
        recipient_uid: Option<String>,
        ciphertext_b64: String,
        #[serde(default)]
        msg_type: Option<u8>,
        created_at: Option<String>,
    },
    Chunk {
        transfer_id: String,
        index: usize,
        total: usize,
        data: String,
    },
    DeliveredAck { message_id: String },
    SeenAck { message_id: String },
    SessionRepair { peer_uid: String },
    CallSignal { to_uid: String, payload: serde_json::Value },
    Ping,
    PresenceOffline,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DataChannelServerFrame {
    SavedAck { message_id: String },
    NewMessage { message: MessageEnvelope },
    SessionRepair { from_uid: String },
    Chunk {
        transfer_id: String,
        index: usize,
        total: usize,
        data: String,
    },
    DeliveredAck { message_id: String },
    SeenAck { message_id: String },
    PresenceUpdate { uid: String, online: bool },
    NewConversation { conversation_id: String, user: UserSummary },
    CallSignal { from_uid: String, payload: serde_json::Value },
    Pong,
    Error { code: String, message: String },
}
