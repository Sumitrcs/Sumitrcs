// Command kvcli is an interactive shell for an lsm-kv database.
//
//	$ kvcli ./data
//	> put user:1 Sumit
//	> get user:1
//	Sumit
//	> scan user: user;
package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strings"

	lsmkv "github.com/Sumitrcs/lsm-kv"
)

func main() {
	dir := "./kvdata"
	if len(os.Args) > 1 {
		dir = os.Args[1]
	}
	db, err := lsmkv.Open(dir, nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer db.Close()

	fmt.Printf("lsm-kv shell — database at %s. Type 'help' for commands.\n", dir)
	sc := bufio.NewScanner(os.Stdin)
	for fmt.Print("> "); sc.Scan(); fmt.Print("> ") {
		args := strings.Fields(sc.Text())
		if len(args) == 0 {
			continue
		}
		if args[0] == "exit" || args[0] == "quit" {
			return
		}
		if err := exec(db, args); err != nil {
			fmt.Println("error:", err)
		}
	}
}

func exec(db *lsmkv.DB, args []string) error {
	need := func(n int) error {
		if len(args) < n+1 {
			return fmt.Errorf("%s needs %d argument(s)", args[0], n)
		}
		return nil
	}
	switch args[0] {
	case "put", "set":
		if err := need(2); err != nil {
			return err
		}
		return db.Put([]byte(args[1]), []byte(strings.Join(args[2:], " ")))
	case "get":
		if err := need(1); err != nil {
			return err
		}
		v, err := db.Get([]byte(args[1]))
		if errors.Is(err, lsmkv.ErrNotFound) {
			fmt.Println("(nil)")
			return nil
		}
		if err == nil {
			fmt.Println(string(v))
		}
		return err
	case "del", "delete":
		if err := need(1); err != nil {
			return err
		}
		return db.Delete([]byte(args[1]))
	case "scan":
		var start, end []byte
		if len(args) > 1 {
			start = []byte(args[1])
		}
		if len(args) > 2 {
			end = []byte(args[2])
		}
		n := 0
		err := db.Scan(start, end, func(k, v []byte) bool {
			fmt.Printf("%s = %s\n", k, v)
			n++
			return n < 1000
		})
		fmt.Printf("(%d keys)\n", n)
		return err
	case "flush":
		return db.Flush()
	case "compact":
		return db.Compact()
	case "stats":
		fmt.Printf("%+v\n", db.Stats())
		return nil
	case "help":
		fmt.Println("put K V | get K | del K | scan [start] [end] | flush | compact | stats | exit")
		return nil
	}
	return fmt.Errorf("unknown command %q", args[0])
}
