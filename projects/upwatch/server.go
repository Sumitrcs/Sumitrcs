package upwatch

import (
	"embed"
	"encoding/json"
	"fmt"
	"html/template"
	"log"
	"math"
	"net/http"
	"sort"
	"time"
)

//go:embed web/status.html
var webFiles embed.FS

// html/template escapes everything it inserts, so a check name like
// <script> is shown as text instead of running in the visitor's browser.
var page = template.Must(template.New("status.html").Funcs(template.FuncMap{
	"percent": func(p float64) string {
		if p < 0 {
			return "—"
		}
		// Round down, so 99.996% shows as 99.99% rather than a misleading 100.00%.
		return fmt.Sprintf("%.2f%%", math.Floor(p*100)/100)
	},
	"ms": func(d time.Duration) string {
		if d == 0 {
			return "—"
		}
		return fmt.Sprintf("%d ms", d.Milliseconds())
	},
	"clock":    func(t time.Time) string { return t.Format("15:04") },
	"when":     func(t time.Time) string { return t.Format("02 Jan 15:04") },
	"duration": func(a, b time.Time) string { return humanDuration(b.Sub(a)) },
	"ago":      func(time.Time) string { return "" }, // replaced per request, see Handler
}).ParseFS(webFiles, "web/status.html"))

func humanDuration(d time.Duration) string {
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%d s", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%d min", int(d.Minutes()))
	default:
		return fmt.Sprintf("%d h %d min", int(d.Hours()), int(d.Minutes())%60)
	}
}

type incidentRow struct {
	Check string
	Incident
}

// Handler serves the status page, a JSON API and a health check.
func Handler(m *Monitor, title string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		checks := m.Snapshot()
		now := m.Now()
		overall, class := Overall(checks)
		var incidents []incidentRow
		for _, c := range checks {
			for _, in := range c.Incidents {
				incidents = append(incidents, incidentRow{c.Name, in})
			}
		}
		sort.Slice(incidents, func(i, j int) bool { return incidents[i].Start.After(incidents[j].Start) })
		if len(incidents) > 10 {
			incidents = incidents[:10]
		}
		favicon := map[string]string{"up": "%231f9d55", "partial": "%23d99a00", "down": "%23d43c3c"}[class]
		if favicon == "" {
			favicon = "%235f6b7a"
		}
		data := map[string]any{
			"Title": title, "Overall": overall, "OverallClass": class, "Checks": checks,
			"Incidents": incidents, "Now": now, "FaviconColor": template.URL(favicon),
		}
		// "ago" needs this request's clock, so it's swapped in on a copy of the template.
		t := template.Must(page.Clone()).Funcs(template.FuncMap{
			"ago": func(at time.Time) string { return humanDuration(now.Sub(at)) + " ago" },
		})
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if err := t.Execute(w, data); err != nil {
			log.Printf("rendering the status page: %v", err)
		}
	})
	mux.HandleFunc("GET /api/status", func(w http.ResponseWriter, r *http.Request) {
		checks := m.Snapshot()
		overall, _ := Overall(checks)
		w.Header().Set("Content-Type", "application/json")
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		enc.Encode(map[string]any{"title": title, "overall": overall, "checks": checks})
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "ok")
	})
	return mux
}
