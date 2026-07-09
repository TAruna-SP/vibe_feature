# Seeds a test user into the Firebase Auth Emulator.
# Run AFTER `firebase emulators:start --only auth` is up and listening on
# 127.0.0.1:9099. Idempotent — skips if the user already exists.
param(
  [string]$Email = "[email protected]",
  [string]$Password = "TestUser123!",
  [string]$DisplayName = "Test User"
)

$body = @{
  email          = $Email
  password       = $Password
  displayName    = $DisplayName
  emailVerified  = $true
  returnSecureToken = $true
} | ConvertTo-Json

$response = Invoke-RestMethod -Method Post `
  -Uri "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key" `
  -ContentType "application/json" `
  -Body $body

Write-Host "Created emulator user: $($response.email)  (localId: $($response.localId))"
