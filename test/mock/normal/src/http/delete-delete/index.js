exports.handler = async (event) => {
  const body = event
  body.message = 'Hello from delete /delete'
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }
}
