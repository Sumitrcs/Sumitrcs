# apicheck

[![CI](https://github.com/Sumitrcs/apicheck/actions/workflows/ci.yml/badge.svg)](https://github.com/Sumitrcs/apicheck/actions/workflows/ci.yml) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg) ![Dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen.svg)

**Write your API tests as a plain JSON file. Run them from the terminal or CI.
Get a JUnit report.** No Postman export, no JavaScript sandbox, no
dependencies — just Python 3.10+.

I got tired of clicking through Postman collections every time a backend
deploy went out, so I wrote the smallest thing that does the job: a list of
requests and what I expect back.

```
$ apicheck run examples/jsonplaceholder.json
examples/jsonplaceholder.json
  PASS  list posts (200, 412ms)
  PASS  fetch the first post (200, 96ms)
  PASS  create a post (201, 301ms)
  PASS  unknown post is 404 (404, 88ms)

4 passed in 0.90s
```

When something breaks you see exactly what:

```
  FAIL  create invoice (201, 640ms)
        - json gst.total: expected 180, got 162
        - time: took 1210ms, limit is 800ms
```

Exit code is `0` when everything passes, `1` when something fails and `2`
for a broken spec file — so it drops straight into any CI pipeline.

## Install

```bash
pip install git+https://github.com/Sumitrcs/apicheck
apicheck init          # writes a starter api.json
apicheck run api.json
```

## A spec file

```json
{
  "base_url": "https://staging.example.com/api",
  "vars": { "password": "${env:API_PASSWORD}" },
  "headers": { "Accept": "application/json" },
  "timeout": 10,
  "tests": [
    {
      "name": "login",
      "method": "POST",
      "path": "/login",
      "json": { "user": "asha", "password": "${password}" },
      "expect": { "status": 200, "json": { "token": { "type": "string" } } },
      "save": { "token": "json:token" }
    },
    {
      "name": "create invoice",
      "method": "POST",
      "path": "/invoices",
      "headers": { "Authorization": "Bearer ${token}" },
      "json": { "customer": "Ravi Traders", "amount": 1180 },
      "expect": {
        "status": 201,
        "headers": { "Location": { "regex": "^/invoices/\\d+$" } },
        "json": { "id": { "type": "integer" }, "gst.total": 180 },
        "max_ms": 800
      },
      "save": { "invoice": "header:location" }
    },
    {
      "name": "invoice shows up",
      "path": "${invoice}",
      "headers": { "Authorization": "Bearer ${token}" },
      "expect": { "status": 200, "json": { "customer": "Ravi Traders" } }
    }
  ]
}
```

Tests run top to bottom. Anything you `save` is available to the tests after
it as `${name}`.

### Request fields

| Field | Meaning |
|---|---|
| `name` | shown in the output and the JUnit report |
| `method` | `GET` by default |
| `path` / `url` | joined to `base_url`; a full `http(s)://` URL is used as-is |
| `query` | object turned into `?a=1&b=2` |
| `headers` | merged over the spec-level `headers` |
| `json` / `form` / `body` | request body (JSON, url-encoded form, or raw text) |
| `timeout` | seconds, overrides the spec-level `timeout` (default 10) |
| `skip` | `true` to skip the test without deleting it |

### Expectations

| Key | Example |
|---|---|
| `status` | `200` or a list of allowed codes `[200, 204]` |
| `headers` | `{"content-type": {"contains": "json"}}` (names are case-insensitive) |
| `json` | `{"data.items.0.name": "pen", "data.total": {"gt": 0}}` |
| `body_contains` | `"OK"` or `["OK", "ready"]` |
| `max_ms` | fail if the response took longer |

JSON paths are dot separated. Numbers index into arrays, `-1` is the last
item and `$` is the whole document (`{"$": {"len": 10}}`).

A value is either compared for equality, or it's a matcher object. You can
combine matchers and every one of them must pass:

| Matcher | Passes when |
|---|---|
| `{"eq": x}` / `{"ne": x}` | equal / not equal |
| `{"type": "string"}` | `string`, `number`, `integer`, `boolean`, `array`, `object`, `null` |
| `{"gt": 0}` `{"gte": 0}` `{"lt": 9}` `{"lte": 9}` | number comparisons |
| `{"contains": "x"}` | substring, or item in a list |
| `{"regex": "^\\d{6}$"}` | the string matches |
| `{"len": 3}` | string / array / object length |
| `{"in": ["paid", "due"]}` | value is one of these |
| `{"exists": false}` | the field must not be there |

### Saving values

`"save": {"var": "SOURCE"}` where SOURCE is `json:path.to.field`,
`header:name`, `status` or `body`. Values are only saved when the test
passed.

### Variables

- `${name}` — from `vars`, from `--var name=value`, or saved by an earlier test
- `${env:NAME}` — an environment variable (keep passwords out of the file)

If a string is just one placeholder, the value keeps its type — `"id":
"${new_id}"` compares as a number, not the string `"42"`.

## Command line

```
apicheck run SPEC [SPEC ...]
    --base-url URL      run the same file against staging / prod / localhost
    --var KEY=VALUE     set or override a variable (repeatable)
    -k TEXT             only tests whose name contains TEXT
    -x, --fail-fast     stop at the first failure
    -q, --quiet         only print failures and the summary
    --junit FILE        write a JUnit XML report
apicheck init [FILE]    write a starter spec
```

## In CI

```yaml
- run: pip install git+https://github.com/Sumitrcs/apicheck
- run: apicheck run tests/api/*.json --base-url "$STAGING_URL" --junit report.xml
  env:
    API_PASSWORD: ${{ secrets.API_PASSWORD }}
```

Jenkins, GitLab and most GitHub Actions test-report actions read the JUnit
file directly.

## Development

```bash
pip install -e ".[dev]"
pytest
```

The test suite spins up a small fake API on localhost, so it runs offline.

## License

MIT
