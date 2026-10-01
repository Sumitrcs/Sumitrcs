package lsmkv

import (
	"bytes"
	"container/heap"
)

type iterator interface {
	valid() bool
	entry() entry
	next()
	close() error
}

// mergeIter merges several sorted iterators. Sources are ordered newest
// first; when the same key appears in more than one, the newest wins and the
// older copies are skipped.
type mergeIter struct {
	h   iterHeap
	cur entry
	ok  bool
	all []iterator
}

type heapItem struct {
	it   iterator
	prio int // lower = newer
}

type iterHeap []heapItem

func (h iterHeap) Len() int { return len(h) }
func (h iterHeap) Less(i, j int) bool {
	c := bytes.Compare(h[i].it.entry().key, h[j].it.entry().key)
	return c < 0 || (c == 0 && h[i].prio < h[j].prio)
}
func (h iterHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *iterHeap) Push(x any)   { *h = append(*h, x.(heapItem)) }
func (h *iterHeap) Pop() any {
	old := *h
	x := old[len(old)-1]
	*h = old[:len(old)-1]
	return x
}

func newMergeIter(sources []iterator) *mergeIter {
	m := &mergeIter{all: sources}
	for i, it := range sources {
		if it.valid() {
			m.h = append(m.h, heapItem{it, i})
		}
	}
	heap.Init(&m.h)
	m.next()
	return m
}

func (m *mergeIter) valid() bool  { return m.ok }
func (m *mergeIter) entry() entry { return m.cur }

func (m *mergeIter) next() {
	if m.h.Len() == 0 {
		m.ok = false
		return
	}
	top := m.h[0]
	e := top.it.entry()
	m.cur = entry{key: append([]byte(nil), e.key...), value: append([]byte(nil), e.value...), deleted: e.deleted}
	m.ok = true
	// Advance every source currently sitting on this key.
	for m.h.Len() > 0 && bytes.Equal(m.h[0].it.entry().key, m.cur.key) {
		it := m.h[0].it
		it.next()
		if it.valid() {
			heap.Fix(&m.h, 0)
		} else {
			heap.Pop(&m.h)
		}
	}
}

func (m *mergeIter) close() error {
	var first error
	for _, it := range m.all {
		if err := it.close(); err != nil && first == nil {
			first = err
		}
	}
	return first
}
