// Minimal PayPal Orders v2 client (sandbox by default).
// If no PayPal keys are set, runs in DEMO mode with a fake approval page (no real PayPal calls).
const BASE = process.env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

export const isPayPalDemo = () => !process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET;

async function getAccessToken() {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

export async function createOrder(items, returnBase) {
  const total = items.reduce((s, i) => s + i.price * i.qty, 0).toFixed(2);

  if (isPayPalDemo()) {
    const orderId = "DEMO-" + crypto.randomUUID().slice(0, 8).toUpperCase();
    return { orderId, approveUrl: `${returnBase}/paypal/demo?token=${orderId}&total=${total}`, total };
  }

  const token = await getAccessToken();
  const body = {
    intent: "CAPTURE",
    purchase_units: [
      {
        description: "AgentCart order",
        amount: {
          currency_code: "USD",
          value: total,
          breakdown: { item_total: { currency_code: "USD", value: total } }
        },
        items: items.map((i) => ({
          name: i.name.slice(0, 127),
          quantity: String(i.qty),
          unit_amount: { currency_code: "USD", value: i.price.toFixed(2) },
          sku: i.id
        }))
      }
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: "AgentCart",
          user_action: "PAY_NOW",
          return_url: `${returnBase}/paypal/return`,
          cancel_url: `${returnBase}/paypal/cancel`
        }
      }
    }
  };
  const res = await fetch(`${BASE}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": crypto.randomUUID()
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`PayPal create order failed: ${res.status} ${JSON.stringify(data)}`);
  const link = (data.links || []).find((l) => l.rel === "payer-action" || l.rel === "approve");
  return { orderId: data.id, approveUrl: link?.href, total };
}

export async function captureOrder(orderId) {
  if (String(orderId).startsWith("DEMO-")) return { status: "COMPLETED", demo: true };
  const token = await getAccessToken();
  const res = await fetch(`${BASE}/v2/checkout/orders/${orderId}/capture`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`PayPal capture failed: ${res.status} ${JSON.stringify(data)}`);
  return data;
}
