# A tour of tinylang

fn fib(n) {
  if n < 2 { return n }
  fib(n - 1) + fib(n - 2)
}
print("fib(20) = {fib(20)}")

# Closures capture their environment
fn counter() {
  let count = 0
  fn() {
    count = count + 1
    count
  }
}
let next = counter()
next(); next()
print("counter: {next()}")

# Higher-order functions and arrow lambdas
let squares = map(1..11, fn(x) => x * x)
let evens = filter(squares, fn(x) => x % 2 == 0)
print("even squares: {evens}")
print("sum: {reduce(squares, fn(a, b) => a + b, 0)}")

# Maps and loops
let invoice = { client: "Acme", items: [1200, 450, 99] }
let total = 0
for amount in invoice.items { total = total + amount }
invoice["total"] = total
print(invoice)

# Quicksort in 6 lines
fn qsort(xs) {
  if len(xs) <= 1 { return xs }
  let pivot = xs[0]
  let rest = filter(xs, fn(x) => x != pivot)
  qsort(filter(rest, fn(x) => x < pivot)) + filter(xs, fn(x) => x == pivot) + qsort(filter(rest, fn(x) => x > pivot))
}
print(qsort([33, 4, 15, 8, 42, 16, 23, 4]))

# FizzBuzz with break/continue
let out = []
for i in 1..100 {
  if i > 15 { break }
  if i % 15 == 0 { push(out, "FizzBuzz"); continue }
  push(out, if i % 3 == 0 { "Fizz" } else if i % 5 == 0 { "Buzz" } else { i })
}
print(join(out, " "))
