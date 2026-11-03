//! Single-instance call arbitration. No network I/O is performed under this lock.
use std::{collections::HashMap, sync::LazyLock, time::{Duration, Instant}};
use serde_json::Value;
use tokio::sync::Mutex;

#[derive(Clone)]
struct Call { caller: String, callee: String, expires: Instant, answered: bool }
#[derive(Default)]
pub struct Registry {
    calls: HashMap<String, Call>,
    users: HashMap<String, String>,
    ended: HashMap<String, Instant>,
    invite_rates: HashMap<String, (Instant, u16)>,
    swept: Option<Instant>,
}
pub enum Decision { Forward, Busy, RateLimited, Ignore }
pub static CALLS: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));

impl Registry {
    fn finish(&mut self, id: &str) {
        if let Some(call) = self.calls.remove(id) {
            self.users.remove(&call.caller); self.users.remove(&call.callee);
            if self.ended.len() >= 100_000 {
                if let Some(old) = self.ended.keys().next().cloned() { self.ended.remove(&old); }
            }
            self.ended.insert(id.to_owned(), Instant::now() + Duration::from_secs(120));
        }
    }
    pub fn decide(&mut self, from: &str, to: &str, payload: &Value) -> Decision {
        let now = Instant::now();
        if self.swept.is_none_or(|at| now.duration_since(at) >= Duration::from_secs(10)) {
            let expired: Vec<_> = self.calls.iter().filter(|(_, c)| c.expires <= now).map(|(id, _)| id.clone()).collect();
            for id in expired { self.finish(&id); }
            self.ended.retain(|_, until| *until > now);
            self.invite_rates.retain(|_, (at, _)| now.duration_since(*at) < Duration::from_secs(10));
            self.swept = Some(now);
        }
        let Some(id) = payload.get("callId").and_then(Value::as_str) else { return Decision::Ignore; };
        let Some(kind) = payload.get("type").and_then(Value::as_str) else { return Decision::Ignore; };
        if from == to || id.is_empty() || id.len() > 128 || !id.is_ascii() { return Decision::Ignore; }
        if self.ended.contains_key(id) { return Decision::Ignore; }
        if kind == "call_invite" {
            if let Some(call) = self.calls.get(id) {
                return if call.caller == from && call.callee == to && !call.answered { Decision::Forward } else { Decision::Ignore };
            }
            if self.invite_rates.len() >= 100_000 && !self.invite_rates.contains_key(from) { return Decision::RateLimited; }
            let entry = self.invite_rates.entry(from.to_owned()).or_insert((now, 0));
            if now.duration_since(entry.0) >= Duration::from_secs(10) { *entry = (now, 0); }
            if entry.1 >= 6 { return Decision::RateLimited; }
            entry.1 += 1;
            if self.users.contains_key(from) || self.users.contains_key(to) || self.calls.len() >= 100_000 { return Decision::Busy; }
            if !payload.get("sdp").is_some_and(Value::is_string) { return Decision::Ignore; }
            self.calls.insert(id.to_owned(), Call { caller: from.to_owned(), callee: to.to_owned(), expires: now + Duration::from_secs(45), answered: false });
            self.users.insert(from.to_owned(), id.to_owned()); self.users.insert(to.to_owned(), id.to_owned());
            return Decision::Forward;
        }
        // Trickle ICE may precede the invite on the authenticated connection.
        // It cannot reserve a call; the client buffers it by sender + call ID.
        if kind == "call_candidate" && !self.calls.contains_key(id) {
            return Decision::Forward;
        }
        let Some(call) = self.calls.get_mut(id) else { return Decision::Ignore; };
        if !((call.caller == from && call.callee == to) || (call.caller == to && call.callee == from)) { return Decision::Ignore; }
        match kind {
            "call_answer" if call.callee == from => { call.answered = true; call.expires = now + Duration::from_secs(90); }
            "call_ringing" if call.callee == from => {},
            "call_reject" | "call_busy" if call.callee == from && !call.answered => self.finish(id),
            "call_end" => self.finish(id),
            "call_candidate" | "call_screen_share" | "call_renegotiate" | "call_renegotiate_answer" => {},
            _ => return Decision::Ignore,
        }
        Decision::Forward
    }
    pub fn touch(&mut self, uid: &str) {
        if let Some(call) = self.users.get(uid).and_then(|id| self.calls.get_mut(id)) {
            if call.answered { call.expires = Instant::now() + Duration::from_secs(90); }
        }
    }
    pub fn undelivered(&mut self, id: &str) { self.finish(id); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn third_caller_and_spoofed_end_cannot_replace_a_call() {
        let mut r = Registry::default();
        assert!(matches!(r.decide("a", "b", &json!({"type":"call_invite","callId":"ab","sdp":"offer"})), Decision::Forward));
        assert!(matches!(r.decide("c", "b", &json!({"type":"call_invite","callId":"cb","sdp":"offer"})), Decision::Busy));
        assert!(matches!(r.decide("c", "b", &json!({"type":"call_end","callId":"ab"})), Decision::Ignore));
        assert!(matches!(r.decide("b", "a", &json!({"type":"call_answer","callId":"ab"})), Decision::Forward));
        assert!(matches!(r.decide("a", "b", &json!({"type":"call_end","callId":"ab"})), Decision::Forward));
        assert!(matches!(r.decide("a", "b", &json!({"type":"call_invite","callId":"ab","sdp":"old"})), Decision::Ignore));
        assert!(matches!(r.decide("c", "b", &json!({"type":"call_invite","callId":"new","sdp":"offer"})), Decision::Forward));
    }

    #[tokio::test]
    async fn one_hundred_callers_get_exactly_one_reservation() {
        let registry = std::sync::Arc::new(Mutex::new(Registry::default()));
        let results = futures_util::future::join_all((0..100).map(|i| {
            let registry = registry.clone();
            async move { matches!(registry.lock().await.decide(&format!("caller{i}"), "recipient", &json!({"type":"call_invite","callId":format!("attempt{i}"),"sdp":"offer"})), Decision::Forward) }
        })).await;
        assert_eq!(results.into_iter().filter(|accepted| *accepted).count(), 1);
    }

    #[test]
    fn invite_flood_is_bounded_and_expired_locks_are_released() {
        let mut r = Registry::default();
        for i in 0..6 {
            let id = format!("call{i}");
            assert!(matches!(r.decide("a", "b", &json!({"type":"call_invite","callId":id,"sdp":"offer"})), Decision::Forward));
            r.undelivered(&id);
        }
        assert!(matches!(r.decide("a", "b", &json!({"type":"call_invite","callId":"flood","sdp":"offer"})), Decision::RateLimited));
        let mut r = Registry::default();
        r.decide("a", "b", &json!({"type":"call_invite","callId":"old","sdp":"offer"}));
        r.calls.get_mut("old").unwrap().expires = Instant::now() - Duration::from_secs(1);
        r.swept = None;
        assert!(matches!(r.decide("c", "b", &json!({"type":"call_invite","callId":"fresh","sdp":"offer"})), Decision::Forward));
    }
}
