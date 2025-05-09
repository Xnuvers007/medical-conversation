import requests
import json
import dotenv, os

# Load environment variables from .env file
dotenv.load_dotenv()

response = requests.post(
  url="https://openrouter.ai/api/v1/chat/completions",
  headers={
    "Authorization": "Bearer " + os.getenv("DEEPSEEKER_API_KEY"),
    "Content-Type": "application/json",
  },
  data=json.dumps({
    "model": "deepseek/deepseek-prover-v2:free",
    "messages": [
      {
        "role": "user",
        "content": "What is the meaning of life?"
      }
    ],
    
  })
)
# Check if the request was successful
if response.status_code == 200:
    # Parse the JSON response
    data = response.json()
    # Print the response
    print(json.dumps(data, indent=2))
else:
    # Print the error message
    print(f"Error: {response.status_code} - {response.text}")