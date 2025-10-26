# Mauki CV - Mentra Live + Auki Network Computer Vision App

A real-time computer vision application for **Mentra smart glasses** that captures images, stores them on an **Auki Domain**, and analyzes them using an **Auki CV Node** (local or cloud).

---

## 🌟 What Does This App Do?

This app enables you to:

- **📸 Capture images** using the short button press on your Mentra glasses
- **🗄️ Store images** on an Auki Domain (decentralized storage)
- **🤖 Analyze images** using AI vision models via an Auki CV Node (local or cloud)
- **🖼️ View gallery** of past images with their analysis results
- **🔊 Get audio feedback** with AI responses spoken through your glasses
- **💬 Change queries** to ask different questions about captured images

---

## 🏗️ Architecture Overview

```
User with Mentra Glasses
        ↓ (Short Press Button)
   Capture Image
        ↓
  Store on Auki Domain
        ↓
  Send to Auki CV Node (Local or Cloud)
        ↓
  Receive AI Analysis
        ↓
  Audio Feedback to User
```

---

## 📋 Prerequisites

Before you begin, ensure you have:

1. **Mentra Smart Glasses** - Physical device required
2. **Node.js** (version 18-22) or **Bun** runtime
3. **Ngrok** or similar tunneling service for public URL
4. **Auki Network Account** - Create at [console.auki.network](https://console.auki.network/)
5. **Mentra Developer Account** - Create at [console.mentra.glass](https://console.mentra.glass/)

---

## 🚀 Setup Instructions

### Step 1: Create an Auki Domain

Your captured images will be stored on an Auki Domain (decentralized storage):

1. Go to [https://console.auki.network/](https://console.auki.network/)
2. Sign in or create an account
3. Navigate to **Domains** section
4. Click **"Create Domain"**
5. Copy your **Domain ID** (format: `0b88e10b-ea0c-488f-83a8-5c88ec84936f`)
6. Save this ID - you'll need it for the `.env` file

### Step 2: Create a Mentra App

Your app needs to be registered with Mentra to work with the glasses:

1. Go to [https://console.mentra.glass/apps](https://console.mentra.glass/apps)
2. Sign in or create an account
3. Click **"Create New App"**
4. Fill in app details:
   - **App Name**: Choose a name (e.g., "Mauki CV")
   - **Package Name**: Use format like `com.yourcompany.maukicv`
   - **Webhook URL**: Your ngrok URL (e.g., `https://your-subdomain.ngrok-free.app`)
5. Copy your **API Key** - you'll need this for the `.env` file

### Step 3: Clone and Install

```bash
# Clone the repository
git clone https://github.com/YourRepo/Mauki.CV.git
cd Mauki.CV

# Install dependencies
npm install
# OR if using Bun
bun install
```

### Step 4: Configure Environment Variables

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` with your credentials:

```env
# Mentra Configuration
MENTRAOS_API_KEY=your_mentra_api_key_here
PACKAGE_NAME=com.yourcompany.maukicv
PORT=3000

# Auki Network Configuration
AUKI_API_BASE_URL=https://api.auki.network
AUKI_DDS_BASE_URL=https://dds.auki.network
AUKI_DEFAULT_DOMAIN_ID=your_auki_domain_id_here
DOMAIN_PUBLIC_KEY_URL=https://eu-central-1.domains.prod.aukiverse.com

# Auki CV Node Configuration
AUKI_VLM_TASK_TYPE=task_timing_v1

# Your Public URL (update this after starting ngrok)
MENTRA_APP_URL=https://your-subdomain.ngrok-free.app

# CV Node Selection (choose one)
# Option 1: Local CV Node (faster, requires local setup)
AUKI_COMPUTE_NODE_URL=http://0.0.0.0:8080/api/v1/jobs

# Option 2: Cloud CV Node (slower but no local setup needed)
# AUKI_COMPUTE_NODE_URL=https://vlm-node.dev.aukiverse.com/api/v1/jobs
```

**Important Configuration Notes:**

- **Local CV Node** (`http://0.0.0.0:8080/api/v1/jobs`):
  - Requires running the [Auki VLM Node](https://github.com/aukilabs/vlm-node) locally
  - First response takes ~1 minute (model warmup)
  - Subsequent responses: **< 1 second** (with a good GPU)
  
- **Cloud CV Node** (`https://vlm-node.dev.aukiverse.com/api/v1/jobs`):
  - No local setup required
  - **Can take several minutes** per image
  - Check cloud status: [https://vlm-node.dev.aukiverse.com/](https://vlm-node.dev.aukiverse.com/)

### Step 5: Set Up Public URL with Ngrok

Your Mentra app needs a public URL to receive webhooks:

```bash
# Start ngrok on the same port as your app
ngrok http 3000
```

Copy the generated URL (e.g., `https://abc123.ngrok-free.app`) and:
1. Update it in your `.env` file as `MENTRA_APP_URL`
2. Update it in the Mentra Console as your app's webhook URL

### Step 6: Start the Application

```bash
# Using npm
npm run dev

# OR using Bun
bun run dev
```

The server will start on `http://localhost:3000`

---

## 📱 Using the App

### Initial Setup on Your Glasses

1. **Open the Mentra app** on your phone
2. **Launch your app** on the Mentra glasses from the phone
3. **Open the webview** on your phone - you'll see a login screen
4. **Login to Auki Network** with your credentials
5. **Configure settings**:
   - Enter your **Domain ID**
   - Choose **Local or Cloud** CV Node
   - Save settings

### Capturing Images

**Short Button Press** on your Mentra glasses:
- Takes a single photo
- Automatically stores it on your Auki Domain
- Sends it to the CV Node for analysis
- Returns audio feedback with the AI analysis

**Long Button Press** (streaming mode):
- Toggles continuous frame capture mode
- Captures frames every 2 seconds
- Short press while streaming publishes the latest frame

### Viewing Your Gallery

1. Open the webview on your phone
2. Click **"Open gallery"** button
3. View your last 6 captured images with:
   - Thumbnail image
   - Timestamp
   - Original query/prompt
   - AI analysis result

### Changing the Query

By default, the app asks: *"Describe what you see in technical terms"*

To change this:

1. Open the webview on your phone
2. Click **"Edit question"** button at the bottom
3. Type your new question (e.g., "What objects are in this image?")
4. Click **"Save question"**
5. All future captures will use this new query

**Query Examples:**
- "What colors do you see?"
- "Describe the scene in detail"
- "What objects are present?"
- "Is this image safe for work?"
- "Count the number of people"

---

## ⚙️ Switching Between Local and Cloud CV Nodes

You can switch between local and cloud processing at any time:

### Method 1: Edit `.env` File (Requires Restart)

```env
# For Local (Fast)
AUKI_COMPUTE_NODE_URL=http://0.0.0.0:8080/api/v1/jobs

# For Cloud (Slower)
AUKI_COMPUTE_NODE_URL=https://vlm-node.dev.aukiverse.com/api/v1/jobs
```

Then restart the app.

### Method 2: Settings Page (No Restart Needed)

1. Open webview on your phone
2. Click **"Settings"**
3. Check or uncheck **"Use cloud VLM"**
4. Optionally enable **"Use fast websocket connection"** for local mode
5. Click **"Save Settings"**

**Performance Comparison:**
- **Local**:
  - First image: ~1 minute (warmup)
  - After warmup: **< 1 second per image** (with good GPU)
- **Cloud**:
  - **Several minutes per image**
  - Status monitoring: [https://vlm-node.dev.aukiverse.com/](https://vlm-node.dev.aukiverse.com/)

---

## 🎯 Key Features

### Image Storage
- All images stored on **Auki Domain** (decentralized storage)
- Images persist across sessions
- Access images from gallery view
- Each image tagged with query and response

### AI Analysis
- Powered by **Auki CV Node** vision models
- Customizable queries for different use cases
- Real-time audio feedback
- Text overlay on webview

### Audio Feedback
- Text-to-speech responses through glasses
- Priority-based audio queue
- Stop TTS button in webview
- Audio notifications for actions

### Gallery View
- Last 6 images with analysis
- Timestamp and metadata
- Refresh to load new captures
- Clean, dark-mode interface

---

## 🔧 Troubleshooting

### "Not authenticated" errors
- Make sure you've logged into Auki Network via the webview
- Check that your Auki credentials are correct

### Images not analyzing
- Verify your `AUKI_COMPUTE_NODE_URL` is correct
- For local: ensure the Auki VLM Node is running
- For cloud:
  - Be patient - responses can take **several minutes**
  - Check cloud node status at [https://vlm-node.dev.aukiverse.com/](https://vlm-node.dev.aukiverse.com/)
  - Consider switching to local node for faster results

### Webhook errors
- Ensure ngrok is running
- Verify `MENTRA_APP_URL` matches your ngrok URL
- Update webhook URL in Mentra Console if ngrok URL changed

### No images in gallery
- Take some photos first with short button press
- Ensure you're logged into Auki Network
- Check that your Domain ID is correct

---

## 📚 Additional Resources

- **Auki Network Console**: [https://console.auki.network/](https://console.auki.network/)
- **Mentra Console**: [https://console.mentra.glass/apps](https://console.mentra.glass/apps)
- **Auki VLM Node (Local)**: [https://github.com/aukilabs/vlm-node](https://github.com/aukilabs/vlm-node)
- **Cloud VLM Status**: [https://vlm-node.dev.aukiverse.com/](https://vlm-node.dev.aukiverse.com/)
- **Mentra SDK Documentation**: Check Mentra developer portal

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

---

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

---

## 💡 Tips for Best Results

1. **Good Lighting**: Take photos in well-lit environments
2. **Clear Subjects**: Keep subjects in focus and centered
3. **Specific Queries**: More specific questions get better answers
4. **Local Node Performance**:
   - Use local CV node when possible for fastest results
   - First query takes ~1 minute (warmup), then < 1 second
   - Requires good GPU for best performance
5. **Cloud Node Patience**: Cloud processing can take several minutes - check status at [vlm-node.dev.aukiverse.com](https://vlm-node.dev.aukiverse.com/)
6. **Internet Connection**: Ensure stable connection for both local and cloud processing

---

