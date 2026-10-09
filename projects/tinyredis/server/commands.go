package server

import (
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/Sumitrcs/tinyredis/resp"
	"github.com/Sumitrcs/tinyredis/store"
)

// command describes one Redis command. arity follows Redis' convention:
// a positive number means exactly that many arguments (including the
// command name); a negative number means "at least" that many.
type command struct {
	arity int
	write bool // writes are appended to the AOF
	run   func(s *Server, args []string, w *resp.Writer) (logged [][]string, err error)
}

var errSyntax = errors.New("ERR syntax error")

var commands map[string]command

func init() {
	commands = map[string]command{
		"PING": {-1, false, cmdPing},
		"ECHO": {2, false, func(_ *Server, a []string, w *resp.Writer) ([][]string, error) { w.Bulk(a[1]); return nil, nil }},
		"SET":  {-3, true, cmdSet},
		"GET":  {2, false, cmdGet},
		"DEL":  {-2, true, cmdDel},
		"EXISTS": {-2, false, func(s *Server, a []string, w *resp.Writer) ([][]string, error) {
			w.Int(int64(s.store.Exists(a[1:]...)))
			return nil, nil
		}},
		"INCR":      {2, true, incrBy(1)},
		"DECR":      {2, true, incrBy(-1)},
		"INCRBY":    {3, true, incrBy(0)},
		"DECRBY":    {3, true, incrBy(0)},
		"EXPIRE":    {3, true, cmdExpire(time.Second)},
		"PEXPIRE":   {3, true, cmdExpire(time.Millisecond)},
		"PEXPIREAT": {3, true, cmdPexpireAt},
		"TTL":       {2, false, cmdTTL(time.Second)},
		"PTTL":      {2, false, cmdTTL(time.Millisecond)},
		"PERSIST": {2, true, func(s *Server, a []string, w *resp.Writer) ([][]string, error) {
			return boolReply(w, s.store.Persist(a[1]), a)
		}},
		"TYPE": {2, false, func(s *Server, a []string, w *resp.Writer) ([][]string, error) {
			w.Simple(s.store.Type(a[1]))
			return nil, nil
		}},
		"KEYS": {2, false, func(s *Server, a []string, w *resp.Writer) ([][]string, error) {
			w.Array(s.store.Keys(a[1]))
			return nil, nil
		}},
		"DBSIZE": {1, false, func(s *Server, _ []string, w *resp.Writer) ([][]string, error) {
			w.Int(int64(s.store.Len()))
			return nil, nil
		}},
		"FLUSHALL": {-1, true, func(s *Server, a []string, w *resp.Writer) ([][]string, error) {
			s.store.Flush()
			w.Simple("OK")
			return [][]string{a[:1]}, nil
		}},
		"LPUSH":   {-3, true, cmdPush(true)},
		"RPUSH":   {-3, true, cmdPush(false)},
		"LPOP":    {2, true, cmdPop(true)},
		"RPOP":    {2, true, cmdPop(false)},
		"LRANGE":  {4, false, cmdRange},
		"LLEN":    {2, false, cmdLLen},
		"HSET":    {-4, true, cmdHSet},
		"HGET":    {3, false, cmdHGet},
		"HDEL":    {-3, true, cmdHDel},
		"HGETALL": {2, false, cmdHGetAll},
		"INFO":    {-1, false, cmdInfo},
		// redis-cli asks for command docs on start-up; an empty reply is fine.
		"COMMAND": {-1, false, func(_ *Server, _ []string, w *resp.Writer) ([][]string, error) { w.Array(nil); return nil, nil }},
	}
}

func cmdPing(_ *Server, a []string, w *resp.Writer) ([][]string, error) {
	switch len(a) {
	case 1:
		w.Simple("PONG")
	case 2:
		w.Bulk(a[1])
	default:
		return nil, errors.New("ERR wrong number of arguments for 'ping' command")
	}
	return nil, nil
}

// SET key value [EX seconds | PX milliseconds] [NX | XX] [KEEPTTL]
func cmdSet(s *Server, a []string, w *resp.Writer) ([][]string, error) {
	var o store.SetOptions
	for i := 3; i < len(a); i++ {
		switch opt := strings.ToUpper(a[i]); opt {
		case "NX":
			o.NX = true
		case "XX":
			o.XX = true
		case "KEEPTTL":
			o.KeepTTL = true
		case "EX", "PX":
			if i+1 >= len(a) || o.TTL != 0 {
				return nil, errSyntax
			}
			n, err := strconv.ParseInt(a[i+1], 10, 64)
			if err != nil || n <= 0 {
				return nil, errors.New("ERR invalid expire time in 'set' command")
			}
			unit := time.Second
			if opt == "PX" {
				unit = time.Millisecond
			}
			o.TTL = time.Duration(n) * unit
			i++
		default:
			return nil, errSyntax
		}
	}
	if (o.NX && o.XX) || (o.KeepTTL && o.TTL != 0) {
		return nil, errSyntax
	}
	if !s.store.Set(a[1], a[2], o) {
		w.Null()
		return nil, nil
	}
	w.Simple("OK")
	// Log relative TTLs as an absolute deadline so replaying the AOF later
	// doesn't give the key a fresh lease on life.
	logged := [][]string{{"SET", a[1], a[2]}}
	if o.KeepTTL {
		logged[0] = append(logged[0], "KEEPTTL")
	}
	if o.TTL != 0 {
		logged = append(logged, []string{"PEXPIREAT", a[1], strconv.FormatInt(s.now().Add(o.TTL).UnixMilli(), 10)})
	}
	return logged, nil
}

func cmdGet(s *Server, a []string, w *resp.Writer) ([][]string, error) {
	v, ok, err := s.store.Get(a[1])
	if err != nil {
		return nil, err
	}
	if !ok {
		w.Null()
	} else {
		w.Bulk(v)
	}
	return nil, nil
}

func cmdDel(s *Server, a []string, w *resp.Writer) ([][]string, error) {
	n := s.store.Del(a[1:]...)
	w.Int(int64(n))
	if n == 0 {
		return nil, nil
	}
	return [][]string{a}, nil
}

func incrBy(fixed int64) func(*Server, []string, *resp.Writer) ([][]string, error) {
	return func(s *Server, a []string, w *resp.Writer) ([][]string, error) {
		delta := fixed
		if fixed == 0 {
			n, err := strconv.ParseInt(a[2], 10, 64)
			if err != nil {
				return nil, store.ErrNotInt
			}
			delta = n
			if strings.EqualFold(a[0], "DECRBY") {
				delta = -n
			}
		}
		n, err := s.store.IncrBy(a[1], delta)
		if err != nil {
			return nil, err
		}
		w.Int(n)
		return [][]string{{"INCRBY", a[1], strconv.FormatInt(delta, 10)}}, nil
	}
}

func cmdExpire(unit time.Duration) func(*Server, []string, *resp.Writer) ([][]string, error) {
	return func(s *Server, a []string, w *resp.Writer) ([][]string, error) {
		n, err := strconv.ParseInt(a[2], 10, 64)
		if err != nil {
			return nil, store.ErrNotInt
		}
		ttl := time.Duration(n) * unit
		if !s.store.Expire(a[1], ttl) {
			w.Int(0)
			return nil, nil
		}
		w.Int(1)
		return [][]string{{"PEXPIREAT", a[1], strconv.FormatInt(s.now().Add(ttl).UnixMilli(), 10)}}, nil
	}
}

func cmdPexpireAt(s *Server, a []string, w *resp.Writer) ([][]string, error) {
	ms, err := strconv.ParseInt(a[2], 10, 64)
	if err != nil {
		return nil, store.ErrNotInt
	}
	return boolReply(w, s.store.Expire(a[1], time.UnixMilli(ms).Sub(s.now())), a)
}

func cmdTTL(unit time.Duration) func(*Server, []string, *resp.Writer) ([][]string, error) {
	return func(s *Server, a []string, w *resp.Writer) ([][]string, error) {
		d := s.store.TTL(a[1])
		if d < 0 {
			w.Int(int64(d)) // -1 or -2
		} else {
			w.Int(int64((d + unit - 1) / unit)) // round up, like Redis
		}
		return nil, nil
	}
}

func cmdPush(left bool) func(*Server, []string, *resp.Writer) ([][]string, error) {
	return func(s *Server, a []string, w *resp.Writer) ([][]string, error) {
		n, err := s.store.Push(a[1], left, a[2:]...)
		if err != nil {
			return nil, err
		}
		w.Int(int64(n))
		return [][]string{a}, nil
	}
}

func cmdPop(left bool) func(*Server, []string, *resp.Writer) ([][]string, error) {
	return func(s *Server, a []string, w *resp.Writer) ([][]string, error) {
		v, ok, err := s.store.Pop(a[1], left)
		if err != nil {
			return nil, err
		}
		if !ok {
			w.Null()
			return nil, nil
		}
		w.Bulk(v)
		return [][]string{a}, nil
	}
}

func cmdRange(s *Server, a []string, w *resp.Writer) ([][]string, error) {
	start, err1 := strconv.Atoi(a[2])
	stop, err2 := strconv.Atoi(a[3])
	if err1 != nil || err2 != nil {
		return nil, store.ErrNotInt
	}
	items, err := s.store.Range(a[1], start, stop)
	if err != nil {
		return nil, err
	}
	w.Array(items)
	return nil, nil
}

func cmdLLen(s *Server, a []string, w *resp.Writer) ([][]string, error) {
	n, err := s.store.LLen(a[1])
	if err != nil {
		return nil, err
	}
	w.Int(int64(n))
	return nil, nil
}

func cmdHSet(s *Server, a []string, w *resp.Writer) ([][]string, error) {
	if len(a)%2 != 0 {
		return nil, errors.New("ERR wrong number of arguments for 'hset' command")
	}
	n, err := s.store.HSet(a[1], a[2:]...)
	if err != nil {
		return nil, err
	}
	w.Int(int64(n))
	return [][]string{a}, nil
}

func cmdHGet(s *Server, a []string, w *resp.Writer) ([][]string, error) {
	v, ok, err := s.store.HGet(a[1], a[2])
	if err != nil {
		return nil, err
	}
	if !ok {
		w.Null()
	} else {
		w.Bulk(v)
	}
	return nil, nil
}

func cmdHDel(s *Server, a []string, w *resp.Writer) ([][]string, error) {
	n, err := s.store.HDel(a[1], a[2:]...)
	if err != nil {
		return nil, err
	}
	w.Int(int64(n))
	return [][]string{a}, nil
}

func cmdHGetAll(s *Server, a []string, w *resp.Writer) ([][]string, error) {
	items, err := s.store.HGetAll(a[1])
	if err != nil {
		return nil, err
	}
	w.Array(items)
	return nil, nil
}

func cmdInfo(s *Server, _ []string, w *resp.Writer) ([][]string, error) {
	w.Bulk("# Server\r\nredis_version:7.0.0-tinyredis\r\ntinyredis_version:1.0.0\r\n" +
		"# Keyspace\r\ndb0:keys=" + strconv.Itoa(s.store.Len()) + "\r\n")
	return nil, nil
}

func boolReply(w *resp.Writer, ok bool, args []string) ([][]string, error) {
	if !ok {
		w.Int(0)
		return nil, nil
	}
	w.Int(1)
	return [][]string{args}, nil
}
