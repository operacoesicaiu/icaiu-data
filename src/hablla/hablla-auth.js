const axios = require('axios');

async function getHabllaHeaders() {
  let token = process.env.HABLLA_TOKEN;
  let isWorkspaceToken = false;

  if (!token) {
    const login = await axios.post(
      'https://api.hablla.com/v1/authentication/login',
      {
        email: process.env.HABLLA_EMAIL,
        password: process.env.HABLLA_PASSWORD
      }
    );
    token = login.data.accessToken;
  }

  if (!token.startsWith('ey')) {
    isWorkspaceToken = true;
  }

  return {
    Authorization: isWorkspaceToken ? token : `Bearer ${token}`,
    accept: 'application/json'
  };
}

module.exports = getHabllaHeaders;