# email-ai

# sec
`ALLOWED_SENDERS` youremail@yourdomain.com
```
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GEMINI_API_KEY
```

# Create Worker KV namespace, then bind it
`EMAIL_MEMORY`

# Deploy command
`npx wrangler deploy --keep-bindings kv`
