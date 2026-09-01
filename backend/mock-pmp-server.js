const express = require('express');
const app = express();
const port = 4000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Fake session store
const sessions = new Set();

const HTML_HEAD = `
  <style>
    body { font-family: system-ui; max-width: 600px; margin: 40px auto; padding: 20px; background: #f4f4f5; }
    .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
    input, button { display: block; width: 100%; margin: 10px 0; padding: 10px; box-sizing: border-box; }
    button { background: #3b82f6; color: white; border: none; border-radius: 6px; cursor: pointer; }
    .toast { display: none; background: #10b981; color: white; padding: 15px; border-radius: 6px; margin-top: 20px; }
  </style>
`;

app.get('/', (req, res) => {
  res.redirect('/login');
});

// Login Page
app.get('/login', (req, res) => {
  res.send(`
    <html>
      <head><title>PMP Login</title>${HTML_HEAD}</head>
      <body>
        <div class="card">
          <h2>PMP Portal Login</h2>
          <form action="/login" method="POST">
            <input type="text" id="username" name="username" placeholder="Username (admin)" required />
            <input type="password" id="password" name="password" placeholder="Password (admin)" required />
            <button type="submit" id="login-submit">Sign in</button>
          </form>
        </div>
      </body>
    </html>
  `);
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === 'admin') {
    sessions.add('auth_token');
    res.redirect('/dashboard');
  } else {
    res.send('<html><body><h3>Invalid credentials</h3><a href="/login">Back</a></body></html>');
  }
});

// Dashboard (Deployments Page)
app.get('/dashboard', (req, res) => {
  res.send(`
    <html>
      <head><title>PMP Dashboard</title>${HTML_HEAD}</head>
      <body>
        <div class="card">
          <h2>Tenant Deployments</h2>
          <p>Welcome, admin! Select an environment to deploy.</p>
          
          <div style="margin-top: 30px;">
            <button id="deploy-button" onclick="document.getElementById('confirm-modal').style.display='block'">
              Deploy to Production
            </button>
          </div>

          <div id="confirm-modal" style="display: none; margin-top: 20px; padding: 20px; border: 1px solid #ddd; border-radius: 6px;">
            <p>Are you sure you want to deploy?</p>
            <button class="confirm-btn" onclick="triggerDeploy()">Confirm</button>
            <button onclick="document.getElementById('confirm-modal').style.display='none'" style="background: #ef4444;">Cancel</button>
          </div>

          <div id="toast" class="toast">
            ✅ Deployment successfully queued!
          </div>
        </div>

        <script>
          function triggerDeploy() {
            document.getElementById('confirm-modal').style.display = 'none';
            // Simulate network delay
            setTimeout(() => {
              const toast = document.getElementById('toast');
              toast.style.display = 'block';
            }, 1000);
          }
        </script>
      </body>
    </html>
  `);
});

app.listen(port, () => {
  console.log(`Mock PMP server running at http://localhost:${port}`);
  console.log(`Test credentials: admin / admin`);
});
