//! The agent's side of the wire contract shared with the page and the gateway. The same
//! file (`tests/fixtures/contract.json`) is read by the Node tests, which check that the
//! page's message builders produce exactly these input messages and that the gateway's
//! status reader accepts exactly these status documents; here the agent checks that it
//! understands every message and writes exactly these documents.
use gome_agent::protocol::{self, InputMsg, MAX_MESSAGE, MAX_TEXT_MESSAGE};
use gome_agent::status::{Accessibility, DisplayState, Screen, Status};
use serde_json::Value;

fn fixture() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/contract.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn every_input_message_of_the_contract_parses_to_the_matching_kind() {
    let fixture = fixture();
    let messages = fixture["input"].as_array().unwrap();
    assert!(messages.len() >= 10, "the fixture covers every kind and the button variants");
    let mut kinds = Vec::new();
    for message in messages {
        let bytes = serde_json::to_vec(message).unwrap();
        let kind = message["type"].as_str().unwrap();
        let limit = if kind == "text" { MAX_TEXT_MESSAGE } else { MAX_MESSAGE };
        assert!(bytes.len() <= limit, "{message}");
        let parsed = protocol::parse(&bytes).unwrap_or_else(|| panic!("the agent drops {message}"));
        let expected = match kind {
            "pointer" => matches!(parsed, InputMsg::Pointer { x, y } if (x, y) == (0.25, 0.5)),
            "button" => matches!(parsed, InputMsg::Button { down, .. } if down == message["down"].as_bool().unwrap()),
            "wheel" => parsed == InputMsg::Wheel { dx: 0, dy: -120 },
            "key" => matches!(parsed, InputMsg::Key { down, .. } if down == message["down"].as_bool().unwrap()),
            "text" => parsed == InputMsg::Text("안녕 😀".into()),
            "release" => parsed == InputMsg::Release,
            "size" => matches!(parsed, InputMsg::Size(size) if (size.w, size.h) == (1920, 1080)),
            other => panic!("the fixture has a kind the test does not know: {other}"),
        };
        assert!(expected, "{message} parsed as {parsed:?}");
        kinds.push(kind.to_string());
    }
    for kind in ["pointer", "button", "wheel", "key", "text", "release", "size"] {
        assert!(kinds.iter().any(|k| k == kind), "the fixture has no {kind} message");
    }
    // The three buttons are distinct in the parse, not just accepted.
    let buttons: Vec<_> = messages
        .iter()
        .filter(|m| m["type"] == "button")
        .map(|m| match protocol::parse(&serde_json::to_vec(m).unwrap()) {
            Some(InputMsg::Button { button, .. }) => button,
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(buttons.len(), 3);
    assert!(buttons[0] != buttons[1] && buttons[1] != buttons[2] && buttons[0] != buttons[2]);
}

#[test]
fn the_notices_the_agent_sends_are_exactly_the_contracts() {
    let fixture = fixture();
    let notices = fixture["notice"].as_array().unwrap();
    assert_eq!(notices.len(), 1, "the agent sends one kind of notice");
    let sent: Value = serde_json::from_str(protocol::NOTICE_REPLACED).unwrap();
    assert_eq!(sent, notices[0]);
    // The notice is not an input message: the agent does not mistake its own wording for one.
    assert!(protocol::parse(protocol::NOTICE_REPLACED.as_bytes()).is_none());
}

fn status(
    screen: Screen,
    display: DisplayState,
    locked: bool,
    last_capture_at: Option<u64>,
    accessibility: Accessibility,
) -> Status {
    Status { screen, accessibility, display, locked, last_capture_at, version: "0.1.0" }
}

#[test]
fn the_status_document_has_exactly_the_keys_and_values_of_the_contract() {
    let fixture = fixture();
    let documents = fixture["status"].as_array().unwrap();
    let written = [
        status(Screen::Granted, DisplayState::Ok, false, Some(1_760_400_000), Accessibility::Granted),
        status(Screen::Suspect, DisplayState::Asleep, true, None, Accessibility::Granted),
    ];
    assert_eq!(documents.len(), written.len());
    for (expected, status) in documents.iter().zip(written) {
        let actual: Value = serde_json::from_str(&status.to_json()).unwrap();
        assert_eq!(actual, expected["json"], "the agent's status document drifted from the contract");
    }
}
