# @agents-comm-bus/pi-matrix

Pi host extension for agents-comm-bus — matrix comm. Bundles the shared [`@agents-comm-bus/pi-core`](https://github.com/remingtonspaz/agents-comm-bus-pi-core).

## Install

```bash
pi install git:github.com/remingtonspaz/agents-comm-bus-pi-matrix
```

## Prerequisites

- An `agents-comm-bus` daemon registered with `agent=pi`:
  ```bash
  agents-comm account-add --project <path> --agent pi --account-label main --comm matrix --bot-token <token>
  ```
