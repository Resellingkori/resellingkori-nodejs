# ResellingKori Node.js SDK

Node.js client and examples for the [ResellingKori Partner API](https://github.com/Resellingkori/partner-docs).

Sell ResellingKori products on your website at your own price — no `npm install` needed.

## Requirements

- Node.js 18 or higher
- No external dependencies (uses built-in `https`)

## Quick Start

```bash
git clone https://github.com/Resellingkori/resellingkori-nodejs.git
cd resellingkori-nodejs

export RK_KEY_ID=rkk_your_key_id
export RK_SECRET=rks_your_secret

node 01_check_connection.js
```

Expected output: **Connected.** ✅

## Use in Your Project

Copy `resellingkori-client.js` into your project:

```js
const ResellingKoriClient = require('./resellingkori-client');

const client = new ResellingKoriClient(
    process.env.RK_KEY_ID,
    process.env.RK_SECRET
);

async function main() {
    // Check connection
    const ping = await client.ping();
    console.log(ping.store_name);

    // Browse catalogue
    const products = await client.getProducts({ per_page: 20 });

    // Validate an order (nothing created)
    const check = await client.validateOrder({
        external_order_id: 'YOUR-ORDER-001',
        items: [{ product_id: 42, quantity: 1, unit_price: '1200.00' }],
        delivery_address: {
            name: 'Customer Name',
            phone: '01700000000',
            address: '123 Example Road',
            district: 'Dhaka',
        },
    });
    console.log('Profit:', check.profit, 'BDT');

    // Place the order
    const order = await client.createOrder({
        external_order_id: 'YOUR-ORDER-001',
        items: [{ product_id: 42, quantity: 1, unit_price: '1200.00' }],
        delivery_address: {
            name: 'Customer Name',
            phone: '01700000000',
            address: '123 Example Road',
            district: 'Dhaka',
        },
    });
    console.log('Order ID:', order.id);
}

main().catch(console.error);
```

## Examples

| File | Run | What it does |
|---|---|---|
| `01_check_connection.js` | `node 01_check_connection.js` | Verify credentials and permissions |
| `02_sync_catalogue.js` | `node 02_sync_catalogue.js` | Download and sync the product catalogue |
| `03_place_order.js` | `node 03_place_order.js --place --ref=ORDER-001` | Validate and place an order |
| `04_follow_orders.js` | `node 04_follow_orders.js --loop=600` | Poll for order status changes |
| `05_webhook_receiver.js` | `node 05_webhook_receiver.js` | Receive signed webhook events |
| `06_register_webhook.js` | `node 06_register_webhook.js` | Register your webhook URL |

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `RK_KEY_ID` | ✅ | — | Your Key ID (`rkk_...`) |
| `RK_SECRET` | ✅ | — | Your Secret (`rks_...`) — server only |
| `RK_BASE_URL` | — | `https://resellingkori.com/wp-json/rk/v1` | Override for sandbox |
| `RK_DATA_DIR` | — | `./rk-data` | Folder for catalogue and order data files |
| `RK_WEBHOOK_PATH` | — | `/resellingkori/webhook` | URL path for the webhook receiver |

## Security

**Never put `RK_SECRET` in browser JavaScript, a mobile app, or a public repository.**  
See [SECURITY.md](https://github.com/Resellingkori/partner-docs/blob/main/SECURITY.md) for the full guide.

## Documentation

- [Getting Started](https://github.com/Resellingkori/partner-docs/blob/main/GETTING_STARTED.md)
- [Full API Guide](https://github.com/Resellingkori/partner-docs/blob/main/PARTNER_API_GUIDE.md)
- [Sandbox Guide](https://github.com/Resellingkori/partner-docs/blob/main/SANDBOX.md)

## License

GPL-2.0-or-later
