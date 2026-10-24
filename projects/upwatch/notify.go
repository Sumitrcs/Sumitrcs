package upwatch

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// webhookBody is what gets POSTed. "text" is what Slack and Google Chat
// display, "content" is what Discord displays; the other fields are for
// programs.
type webhookBody struct {
	Text    string `json:"text"`
	Content string `json:"content"`
	Event
}

// Message is the human-readable line for an event.
func (e Event) Message() string {
	if e.To == Down {
		return fmt.Sprintf("🔴 %s is DOWN: %s", e.Check, e.Reason)
	}
	if e.From == Down {
		return fmt.Sprintf("🟢 %s is back UP", e.Check)
	}
	return fmt.Sprintf("🟢 %s is UP", e.Check)
}

// SendWebhook POSTs an event as JSON.
func SendWebhook(ctx context.Context, client *http.Client, url string, e Event) error {
	msg := e.Message()
	body, err := json.Marshal(webhookBody{Text: msg, Content: msg, Event: e})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("webhook answered %s", resp.Status)
	}
	return nil
}
