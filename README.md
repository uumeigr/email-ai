# email-ai

# sec
`ALLOWED_SENDERS` youremail@yourdomain.com
```
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GEMINI_API_KEY
```

# Create Worker KV namespace, then bind it
`EMAIL_MEMORY`

# Build var
`EMAIL_MEMORY`  KV id

# Deploy command
`node -e 'const fs=require("fs"),c=JSON.parse(fs.readFileSync("wrangler.jsonc","utf8").replace(/\/\/.*$/gm,""));c.kv_namespaces=[{binding:"EMAIL_MEMORY",id:process.env.KV_MEMORY_ID}];fs.writeFileSync("wrangler.deploy.json",JSON.stringify(c))' && npx wrangler deploy -c wrangler.deploy.json --keep-vars
`
