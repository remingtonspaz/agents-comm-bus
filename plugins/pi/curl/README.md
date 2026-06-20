# @agents-comm-bus/pi-curl

Pi host extension for agents-comm-bus — curl comm. Bundles the shared [`@agents-comm-bus/pi-core`](https://github.com/remingtonspaz/agents-comm-bus-pi-core).

## Install

```bash
pi install git:github.com/remingtonspaz/agents-comm-bus-pi-curl
```

## Prerequisites

- An `agents-comm-bus` daemon registered with `agent=pi`:
  ```bash
  agents-comm account-add --project <path> --agent pi --account-label main --comm curl --bot-token <token>
  ```
