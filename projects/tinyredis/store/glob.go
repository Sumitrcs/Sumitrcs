package store

// Glob reports whether s matches a Redis-style pattern:
//
//   - any sequence (including "/" — unlike filepath.Match)
//     ?      any single character
//     [abc]  one of a, b, c      [^a] anything but a      [a-z] a range
//     \x     a literal x
//
// It backtracks only to the most recent '*', so it runs in O(len(p)·len(s)).
func Glob(p, s string) bool {
	pi, si := 0, 0
	starP, starS := -1, 0
	for si < len(s) {
		if pi < len(p) {
			switch p[pi] {
			case '*':
				starP, starS = pi, si
				pi++
				continue
			case '?':
				pi++
				si++
				continue
			case '[':
				if end, ok := matchClass(p, pi, s[si]); end > 0 {
					if ok {
						pi = end
						si++
						continue
					}
				} else if p[pi] == s[si] { // unterminated '[' is a literal
					pi++
					si++
					continue
				}
			case '\\':
				if pi+1 < len(p) && p[pi+1] == s[si] {
					pi += 2
					si++
					continue
				}
			default:
				if p[pi] == s[si] {
					pi++
					si++
					continue
				}
			}
		}
		if starP < 0 {
			return false
		}
		// Let the last '*' swallow one more character and retry.
		starS++
		si = starS
		pi = starP + 1
	}
	for pi < len(p) && p[pi] == '*' {
		pi++
	}
	return pi == len(p)
}

// matchClass checks c against the class starting at p[i] == '['. It returns
// the index just past ']' (0 if the class is unterminated) and whether c matched.
func matchClass(p string, i int, c byte) (int, bool) {
	j := i + 1
	negate := j < len(p) && p[j] == '^'
	if negate {
		j++
	}
	matched := false
	for first := true; j < len(p) && (first || p[j] != ']'); first = false {
		lo := p[j]
		if lo == '\\' && j+1 < len(p) {
			j++
			lo = p[j]
		}
		hi := lo
		if j+2 < len(p) && p[j+1] == '-' && p[j+2] != ']' {
			hi = p[j+2]
			j += 2
		}
		if lo > hi {
			lo, hi = hi, lo
		}
		if c >= lo && c <= hi {
			matched = true
		}
		j++
	}
	if j >= len(p) {
		return 0, false
	}
	return j + 1, matched != negate
}
