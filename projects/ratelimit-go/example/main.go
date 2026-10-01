// A tiny API server protected by a per-IP GCRA limiter.
//
//	go run ./example
//	for i in $(seq 1 7); do curl -si localhost:8080/ | head -1; done
package main

import (
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/Sumitrcs/ratelimit-go"
)

func main() {
	lim := ratelimit.New(ratelimit.GCRA(5, 10*time.Second)) // 5 requests / 10s per IP
	stop := make(chan struct{})
	defer close(stop)
	lim.StartJanitor(time.Minute, stop)

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "hello %s\n", ratelimit.ByIP(r))
	})

	log.Println("listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", ratelimit.Middleware(lim, ratelimit.ByIP)(mux)))
}
