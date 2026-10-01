package journal

import (
	"fmt"
	"strconv"
	"strings"
)

// Amount is a fixed-point value in hundredths (paise / cents).
// Using integers keeps every balance exact no matter how many postings.
type Amount int64

// ParseAmount accepts "1234", "-1,23,456.5", "₹ 99.99" and "INR 10".
func ParseAmount(s string) (Amount, error) {
	orig := s
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "INR")
	s = strings.TrimPrefix(s, "₹")
	s = strings.ReplaceAll(strings.TrimSpace(s), ",", "")
	if s == "" {
		return 0, fmt.Errorf("empty amount")
	}

	neg := false
	if s[0] == '-' || s[0] == '+' {
		neg = s[0] == '-'
		s = s[1:]
	}

	whole, frac, hasDot := strings.Cut(s, ".")
	if hasDot && (len(frac) == 0 || len(frac) > 2) {
		return 0, fmt.Errorf("invalid amount %q: use at most two decimals", orig)
	}
	for len(frac) < 2 {
		frac += "0"
	}
	w, err := strconv.ParseInt(whole, 10, 64)
	if err != nil || w < 0 {
		return 0, fmt.Errorf("invalid amount %q", orig)
	}
	f, err := strconv.ParseInt(frac, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid amount %q", orig)
	}
	v := Amount(w*100 + f)
	if neg {
		v = -v
	}
	return v, nil
}

// String formats with Indian digit grouping, e.g. -12,34,567.80.
func (a Amount) String() string {
	neg := a < 0
	if neg {
		a = -a
	}
	whole := strconv.FormatInt(int64(a)/100, 10)
	frac := int64(a) % 100

	var grouped string
	if len(whole) <= 3 {
		grouped = whole
	} else {
		head, tail := whole[:len(whole)-3], whole[len(whole)-3:]
		var parts []string
		for len(head) > 2 {
			parts = append([]string{head[len(head)-2:]}, parts...)
			head = head[:len(head)-2]
		}
		if head != "" {
			parts = append([]string{head}, parts...)
		}
		grouped = strings.Join(parts, ",") + "," + tail
	}

	sign := ""
	if neg {
		sign = "-"
	}
	return fmt.Sprintf("%s%s.%02d", sign, grouped, frac)
}
