# AgentCart

An AI shopping agent for the PayPal AI Hackathon. Tell it what you need and your budget (for example "gaming setup under $150"). The agent searches the catalog with tool calls, builds a cart within budget, and checks out through PayPal. The shopper always approves the payment themselves on PayPal.

## How it works

- **Agent**: tool-calling loop (`search_products`, `add_to_cart`, `remove_from_cart`, `view_cart`, `checkout`) running on Claude, Gemini (free key), or a scripted demo mode when no key is set.
- **PayPal**: Orders v2 API in the sandbox. The server creates the order, the shopper approves in a PayPal popup, and the server captures it on return. With no PayPal keys, a fake approval page is used.
- **Safety**: the agent never sees payment details and only checks out after explicit confirmation.

## Run it

Requires Node 18+.

```bash
npm install
cp .env.example .env    # optional: add keys (Windows: copy .env.example .env)
npm start
```

Open http://localhost:3000. The page footer of the right panel shows which AI and PayPal mode are active.

| You set | AI | PayPal |
|---|---|---|
| nothing | scripted demo | fake page |
| GEMINI_API_KEY | Gemini | fake page |
| ANTHROPIC_API_KEY | Claude | fake page |
| + PAYPAL_CLIENT_ID and SECRET | (same) | real sandbox |

On Windows PowerShell use `npm.cmd` instead of `npm` if scripts are blocked.

## Testing notes for judges

Add a PayPal sandbox app's keys to `.env` and pay with any sandbox buyer account (developer.paypal.com > Testing Tools > Sandbox Accounts). No real money moves.

## Roadmap

- Live product source (e.g. Channel3) instead of the built-in catalog.
- Persistent sessions and orders.

## License

MIT
