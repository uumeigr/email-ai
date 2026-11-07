# email-ai

# sec
`ALLOWED_SENDERS` youremail@yourdomain.com
```
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GEMINI_API_KEY
```

# Create Worker KV namespace, then bind it
`EMAIL_MEMORY`

# check worker log and also email routing activity log

# Build var
`EMAIL_MEMORY`  KV id

# Deploy command
`bun -e 'const c=Bun.JSONC.parse(await Bun.file("wrangler.jsonc").text());c.kv_namespaces=[{binding:"EMAIL_MEMORY",id:process.env.KV_MEMORY_ID}];await Bun.write("wrangler.deploy.json",JSON.stringify(c))' && npx wrangler deploy -c wrangler.deploy.json --keep-vars`
