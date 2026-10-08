package lsmkv

import (
	"bytes"
	"math/rand/v2"
)

const maxLevel = 16

// entry is a key with either a value or a tombstone.
type entry struct {
	key     []byte
	value   []byte
	deleted bool
}

type skipNode struct {
	entry
	next [maxLevel]*skipNode
}

// memtable is a skip list ordered by key. Writes overwrite in place, so the
// list always holds the newest version of each key. Not safe for concurrent
// use on its own — DB guards it with a lock.
type memtable struct {
	head   skipNode
	level  int
	count  int
	size   int // approximate bytes, used to decide when to flush
	random *rand.Rand
}

func newMemtable() *memtable {
	return &memtable{level: 1, random: rand.New(rand.NewPCG(1, 2))}
}

func (m *memtable) randomLevel() int {
	lvl := 1
	for lvl < maxLevel && m.random.Uint32()&3 == 0 { // p = 1/4
		lvl++
	}
	return lvl
}

func (m *memtable) put(key, value []byte, deleted bool) {
	var update [maxLevel]*skipNode
	x := &m.head
	for i := m.level - 1; i >= 0; i-- {
		for x.next[i] != nil && bytes.Compare(x.next[i].key, key) < 0 {
			x = x.next[i]
		}
		update[i] = x
	}

	if n := x.next[0]; n != nil && bytes.Equal(n.key, key) {
		m.size += len(value) - len(n.value)
		n.value, n.deleted = value, deleted
		return
	}

	lvl := m.randomLevel()
	if lvl > m.level {
		for i := m.level; i < lvl; i++ {
			update[i] = &m.head
		}
		m.level = lvl
	}
	n := &skipNode{entry: entry{key: key, value: value, deleted: deleted}}
	for i := 0; i < lvl; i++ {
		n.next[i] = update[i].next[i]
		update[i].next[i] = n
	}
	m.count++
	m.size += len(key) + len(value) + 16
}

// get reports (value, deleted, found).
func (m *memtable) get(key []byte) ([]byte, bool, bool) {
	x := &m.head
	for i := m.level - 1; i >= 0; i-- {
		for x.next[i] != nil && bytes.Compare(x.next[i].key, key) < 0 {
			x = x.next[i]
		}
	}
	if n := x.next[0]; n != nil && bytes.Equal(n.key, key) {
		return n.value, n.deleted, true
	}
	return nil, false, false
}

// seek returns the first node with key >= start.
func (m *memtable) seek(start []byte) *skipNode {
	x := &m.head
	for i := m.level - 1; i >= 0; i-- {
		for x.next[i] != nil && bytes.Compare(x.next[i].key, start) < 0 {
			x = x.next[i]
		}
	}
	return x.next[0]
}

type memIter struct{ n *skipNode }

func (it *memIter) valid() bool  { return it.n != nil }
func (it *memIter) entry() entry { return it.n.entry }
func (it *memIter) next()        { it.n = it.n.next[0] }
func (it *memIter) close() error { return nil }
func (m *memtable) iter(start []byte) iterator {
	return &memIter{n: m.seek(start)}
}
