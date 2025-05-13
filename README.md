# 🩺 Medical Conversation

<div align="center">

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-v20.0.0+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express.js](https://img.shields.io/badge/Express.js-v5.1.0-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![Baileys](https://img.shields.io/badge/Baileys-v6.7.16-25D366?logo=whatsapp&logoColor=white)](https://github.com/whiskeysockets/baileys)
[![DeepSeek AI](https://img.shields.io/badge/DeepSeek%20AI-Powered-FF6F61?logo=openai&logoColor=white)](https://github.com/deepseek-ai/DeepSeek-Prover-V2)

**A secure, AI-powered WhatsApp platform that connects patients with healthcare professionals, enabling seamless medical consultations, secure communication, and AI-driven insights.**

</div>

---

# Table of Contents

1. [🩺 Medical Conversation](#-medical-conversation)
2. [Key Features](#key-features)
3. [Quick Start](#quick-start)
   - [Prerequisites](#prerequisites)
   - [Installation](#installation)
   - [Environment Variables](#environment-variables)
   - [Running the Application](#running-the-application)
4. [Documentation](#documentation)
   - [API Endpoints](#api-endpoints)
   - [WhatsApp Bot Commands](#whatsapp-bot-commands)
5. [🤝 Contributing](#-contributing)
6. [📜 License](#-license)
7. [Acknowledgments](#acknowledgments)
8. [📬 Contact & Support](#-contact--support)

---

## Key Features

- **AI-Powered Medical Assistance**: Integrates with DeepSeek's AI to provide medical insights and answer patient queries.
- **Secure WhatsApp Integration**: Built with Baileys, ensuring reliable and secure WhatsApp communication.
- **User-Friendly Admin Dashboard**: Manage doctors, patients, and consultations through an intuitive interface.
- **Comprehensive Booking System**: Patients can book consultations with specialists directly through the bot.
- **Data Security**: Implements best practices for data protection and user privacy.

---

## Quick Start

### Prerequisites

- Node.js (v20.0.0 or higher)
- npm or yarn
- SQLite database
- DeepSeek API Key

### Installation

```bash
# Clone the repository
git clone https://github.com/Xnuvers007/medical-conversation.git

# Navigate to the project directory
cd whatsapp-ai-doctor-bot

# Install dependencies
npm install

# Create a .env file
cp .env.example .env

# Set up your environment variables
nano .env
```

### Environment Variables

```env
# .env file example
DEEPSEEKER_API_KEY=your_api_key_here
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin_password
NODE_ENV=development
```

### Running the Application

```bash
# Start the server
npm start
```

Visit `http://localhost:3000` to access the application.

---

## Documentation

### API Endpoints

| **Endpoint**                | **Method** | **Description**                                    | **Access Level**      |
|-----------------------------|------------|----------------------------------------------------|-----------------------|
| **/register**                | POST       | Register a new user (patient or doctor)            | Public (All users)    |
| **/login**                   | POST       | User login with credentials                        | Public (All users)    |
| **/book**                    | POST       | Book a consultation with a doctor                  | Authenticated users   |
| **/doctors**                 | GET        | Retrieve a list of available doctors               | Authenticated users   |
| **/admin**                   | GET        | Access the admin dashboard for management purposes | Admin only            |

### WhatsApp Bot Commands

| **Command**      | **Description**                                     | **Access Level**      |
|------------------|-----------------------------------------------------|-----------------------|
| **.menu**        | Display available commands                          | All users             |
| **.ai**          | Ask a medical question to the AI                    | All users             |
| **.gambar**      | Send a test image                                   | All users             |
| **.kirim**       | Send a message to a patient                         | Doctor only           |
| **.listpasien**  | List active patients                                | Doctor only           |
| **.lanjut**      | Resume a consultation session                       | Doctor only           |

---

## 🤝 Contributing

We welcome contributions to the Medical Conversation! Please follow these steps:

1. Fork the repository, [Click This for Fork](https://github.com/Xnuvers007/medical-conversation/fork)
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request


---

## 📜 License

This project is licensed under the ISC License - see the [LICENSE](LICENSE) file for details.

---

## Acknowledgments

| **Library/Tool**        | **Description**                             | **Link**                                                      |
|-------------------------|---------------------------------------------|--------------------------------------------------------------|
| **Baileys**             | WhatsApp integration library                | [Baileys](https://github.com/whiskeysockets/baileys)          |
| **DeepSeek AI**         | Medical AI support tool                     | [DeepSeek AI](https://github.com/deepseek-ai/DeepSeek-Prover-V2)|
| **Express.js**          | Web framework for building web applications | [Express.js](https://expressjs.com/)                          |

---

## 📬 Contact & Support

For questions, support, or feedback:

- 📧 Email: [xnuversh1kar4@gmail.com](mailto:xnuversh1kar4@gmail.com)
- 💬 GitHub Issues: [Report a bug or request a feature](https://github.com/Xnuvers007/medical-conversation/issues)
- 🐱 Pull Request: [Contributor ? add Feature ? just pull req](https://github.com/Xnuvers007/medical-conversation/pulls)

---

<div align="center">

**Made with ❤️ by [Xnuvers007](https://github.com/Xnuvers007)**

*© 2025 Xnuvers007. All rights reserved.*

</div>
