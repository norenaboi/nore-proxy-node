import asyncio
import json
import logging
import uuid
import time
import os
from contextlib import asynccontextmanager
from typing import Dict, Optional, Set, AsyncGenerator
from dataclasses import dataclass, field, asdict
from enum import Enum
import uvicorn
from fastapi import FastAPI, Request, HTTPException, Response, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse, StreamingResponse, JSONResponse
from starlette.responses import StreamingResponse
import traceback
from datetime import datetime, timedelta
from collections import defaultdict, deque
import threading
from pathlib import Path
import aiohttp
import requests
import typing
import gzip
import shutil
from prometheus_client import Counter, Histogram, Gauge, generate_latest, CONTENT_TYPE_LATEST
from dotenv import load_dotenv

load_dotenv()

# --- Configuration ---
class Config:
    LOG_DIR = Path("logs")
    REQUEST_LOG_FILE = "requests.jsonl"
    ERROR_LOG_FILE = "errors.jsonl"
    MAX_LOG_SIZE = 50 * 1024 * 1024
    MAX_LOG_FILES = 50 
    
    HOST = "127.0.0.1"
    PORT = 8741
    
    REQUEST_TIMEOUT_SECONDS = 180
    
    STATS_UPDATE_INTERVAL = 5 
    CLEANUP_INTERVAL = 300 
    
    MAX_LOG_MEMORY_ITEMS = 1000 
    MAX_REQUEST_DETAILS = 500 

    MASTER_KEY = os.getenv("MASTER_KEY")
    RPD_DEFAULT = int(os.getenv("RPD_DEFAULT", 500))
    RPM_DEFAULT = int(os.getenv("RPM_DEFAULT", 10))
    
    # Dynamic endpoints storage
    ENDPOINTS: Dict[str, dict] = {}
    
    # Dynamic endpoints storage
    ENDPOINTS: Dict[str, dict] = {}
    
    @classmethod
    def load_endpoints(cls):
        """Dynamically load all V{n}_URL and V{n}_TOKEN from .env"""
        cls.ENDPOINTS = {}
        
        # Load from environment - check up to 100 endpoints
        i = 1
        while True:
            url = os.getenv(f"V{i}_URL")
            token = os.getenv(f"V{i}_TOKEN")
            
            if url and token:
                cls.ENDPOINTS[f"v{i}"] = {
                    "url": url,
                    "token": token
                }
                i += 1
            elif i > 100:  # Safety limit
                break
            else:
                # Check if there might be gaps (e.g., V1, V3 without V2)
                # Look ahead 10 more indices before giving up
                found_more = False
                for j in range(i + 1, i + 11):
                    if os.getenv(f"V{j}_URL"):
                        found_more = True
                        break
                if not found_more:
                    break
                i += 1
        
        logging.info(f"Loaded {len(cls.ENDPOINTS)} endpoints from environment")
        return cls.ENDPOINTS

# === CREATE LOGS DIRECTORY ===
Config.LOG_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s.%(msecs)03d - %(levelname)s - [%(funcName)s:%(lineno)d] - %(message)s',
    datefmt='%H:%M:%S',
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(Config.LOG_DIR / "server.log", encoding='utf-8')
    ]
)

def load_environ():
    """Reload environment variables and endpoints"""
    load_dotenv(override=True)
    
    Config.MASTER_KEY = os.getenv("MASTER_KEY")
    Config.RPD_DEFAULT = int(os.getenv("RPD_DEFAULT", 1000))
    Config.RPM_DEFAULT = int(os.getenv("RPM_DEFAULT", 60))
    
    # Load all endpoints dynamically
    Config.load_endpoints()

def get_local_ip():
    return "0.0.0.0"

# --- API KEY IMPLEMENTATION ---

async def verify_api_key(authorization: str = Header(..., alias="Authorization")):
    """Dependency to verify API key and enforce rate limits"""
    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=401,
            detail="Invalid authorization header format. Expected 'Bearer <token>'"
        )
    
    api_key = authorization.replace("Bearer ", "", 1)

    if not api_key_manager.validate_key(api_key):
        raise HTTPException(
            status_code=401,
            detail="Invalid or missing API key"
        )
    
    return api_key

async def verify_api_key_for_stats(authorization: str = Header(..., alias="Authorization")):
    """Dependency to verify API key and enforce rate limits"""
    
    api_key = authorization
    
    if not api_key_manager.validate_key(api_key):
        raise HTTPException(
            status_code=401,
            detail="Invalid or missing API key"
        )
    
    return api_key

async def verify_master_key(master_key: str = Header(..., alias="Authorization")):
    if master_key != Config.MASTER_KEY:
        raise HTTPException(status_code=403, detail="Invalid master key")
    return True

class APIKeyManager:
    def __init__(self, key_file='api_keys.json'):
        self.key_file = key_file
        self.keys = {}
        self.load_keys()
    
    def load_keys(self):
        try:
            with open(self.key_file, 'r') as f:
                data = json.load(f)
                # Handle the old format if necessary, or strictly load new format
                self.keys = data.get("keys", {})
        except FileNotFoundError:
            self.keys = {}

    def get_keys(self):
        """Get all API keys with their names"""
        return [
            {
                'api_key': key, 
                'name': self.keys[key].get('name', 'Unnamed'), 
                'active': self.keys[key].get('active', False), 
                'usage_today': self.keys[key].get('usage_today', 'NaN'), 
                'rpd': self.keys[key].get('rpd', 'NaN')
            }
            for key in self.keys
        ]
    
    def save_keys(self):
        # Write back to file to persist usage counts and reset dates
        with open(self.key_file, 'w') as f:
            json.dump({"keys": self.keys}, f, indent=2)

    def validate_key(self, api_key: str):
        # 1. Check if key exists
        if api_key not in self.keys:
            raise HTTPException(status_code=401, detail="Invalid API Key")
        
        return True
    def check_for_generation(self, api_key: str):
        # 1. Check if key exists
        if api_key not in self.keys:
            raise HTTPException(status_code=401, detail="Invalid API Key")

        key_data = self.keys[api_key]

        # 2. Check if key is Active (Manual deactivation via JSON)
        if not key_data.get("active", True):
            raise HTTPException(status_code=403, detail="Your API Key is deactivated. Please contact the admin for reactivation.")

        # 3. Check RPD Limit
        rpd_limit = key_data.get("rpd", Config.RPD_DEFAULT)
        if int(key_data["usage_today"]) >= int(rpd_limit):
            error_msg=(f"You exceeded your requests per day limit ({rpd_limit}). Please wait until it resets at midnight.")
            error_response = {
                "error": {
                    "message": error_msg,
                    "type": "server_error",
                    "code": 429
                }
            }
            raise HTTPException(status_code=429, detail=error_msg)

        rate_limiter.check_rate_limit(api_key, rate_limit=Config.RPM_DEFAULT)
        
        self.rate_limit_increment(api_key)

        return True

    def rate_limit_increment(self, api_key: str):
        # 1. Check if key exists
        if api_key not in self.keys:
            raise HTTPException(status_code=401, detail="Invalid API Key")

        key_data = self.keys[api_key]

        key_data["usage_today"] += 1
        self.save_keys()
        
        return True

    def reset_daily(self):
        for api_key in self.keys:
            key_data = self.keys[api_key]

            # Handle UTC Date Reset
            current_utc_date = datetime.now().strftime("%Y-%m-%d")
        
            if key_data.get("last_reset_date") != current_utc_date:
                key_data["usage_today"] = 0
                key_data["last_reset_date"] = current_utc_date
                # Save immediately to record the reset
                self.save_keys()
    
    def add_key(self, api_key, name, rpd=Config.RPD_DEFAULT):
        self.keys[api_key] = {
            "name": name,
            "active": True,
            "rpd": rpd,
            "usage_today": 0,
            "last_reset_date": datetime.now().strftime("%Y-%m-%d")
        }
        self.save_keys()
    
    def remove_key(self, api_key: str):
        """Remove an API key"""
        if self.keys.pop(api_key, None):
            self.save_keys()
    
    def update_key(self, api_key: str, name: str, rpd: int, active: bool):
        if api_key in self.keys:
            self.keys[api_key]['name'] = name  
            self.keys[api_key]['rpd'] = rpd
            self.keys[api_key]['active'] = active
            self.save_keys()
        else:
            raise HTTPException(status_code=404, detail=f"This API key do not exist: {api_key}")
    
    def get_key_name(self, api_key: str) -> str:
        """Get the friendly name for an API key"""
        if self.validate_key(api_key):
            return self.keys[api_key]['name']
        else:
            return "Unknown"
    
    def reload_keys(self):
        """Reload keys from file (useful for runtime updates)"""
        self.load_key_info()
    
    def get_usage_stats(self, api_key: str) -> dict:
        """Get usage statistics for an API key"""
        # Read logs and filter by API key
        logs = log_manager.read_request_logs(limit=10000)
        current_time = time.time()
        day_ago = current_time - 86400
    
        # Filter logs for this API key in the last 24 hours
        api_key_logs_24h = [
            log for log in logs 
            if log.get('api_key') == api_key and log.get('timestamp', 0) > day_ago
        ]
    
        api_key_logs_all = [
            log for log in logs 
            if log.get('api_key') == api_key
        ]

        total_requests = len(api_key_logs_all)
        daily_requests = len(api_key_logs_24h)
        total_input_tokens = sum(log.get('input_tokens', 0) for log in api_key_logs_all)
        total_output_tokens = sum(log.get('output_tokens', 0) for log in api_key_logs_all)
        daily_input_tokens = sum(log.get('input_tokens', 0) for log in api_key_logs_24h)
        daily_output_tokens = sum(log.get('output_tokens', 0) for log in api_key_logs_24h)
    
        return {
            "name": self.keys[api_key].get('name', 0),
            "daily_requests": self.keys[api_key].get('usage_today', 0),
            "total_requests": total_requests,
            'total_input_tokens': total_input_tokens,
            'total_output_tokens': total_output_tokens,
            'daily_input_tokens': daily_input_tokens,
            'daily_output_tokens': daily_output_tokens,
            "rate_limit": self.keys[api_key].get('rpd', 0),
            'active': self.keys[api_key].get('active', False)
        }

async def scheduled_daily_reset():
    while not SHUTTING_DOWN:
        now = datetime.now()
        # Calculate seconds until next midnight
        tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        seconds_until_midnight = (tomorrow - now).total_seconds()
        
        await asyncio.sleep(seconds_until_midnight)
        
        if not SHUTTING_DOWN:
            api_key_manager.reset_daily()
            logging.info("Daily reset triggered at midnight")

class RateLimiter:
    def __init__(self):
        self.api_key_usage = defaultdict(list)
    
    def check_rate_limit(self, api_key: str, rate_limit: int = Config.RPM_DEFAULT):
        current_time = time.time()
        
        # Clean up old timestamps (older than 60 seconds)
        self.api_key_usage[api_key] = [t for t in self.api_key_usage[api_key] if current_time - t < 60]
        
        if len(self.api_key_usage[api_key]) >= rate_limit:
            # Calculate seconds until oldest request expires (60 seconds window)
            oldest_timestamp = min(self.api_key_usage[api_key])
            retry_after = int(60 - (current_time - oldest_timestamp))
            retry_after = max(1, retry_after)  # At least 1 second

            error_msg=(f"You exceeded your requests per minute limit ({rate_limit}). Please wait and try after {retry_after} seconds.")
            error_response = {
                "error": {
                    "message": error_msg,
                    "type": "server_error",
                    "code": 429
                }
            }
            raise HTTPException(status_code=429, detail=error_msg)
        
        self.api_key_usage[api_key].append(current_time)

rate_limiter = RateLimiter();
api_key_manager = APIKeyManager();

# --- Prometheus Metrics ---
request_count = Counter(
    'proxy_requests_total', 
    'Total number of requests',
    ['model', 'status', 'type']
)

request_duration = Histogram(
    'proxy_request_duration_seconds',
    'Request duration in seconds',
    ['model', 'type'],
    buckets=(0.1, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0, float("inf"))
)

active_requests_gauge = Gauge(
    'proxy_active_requests',
    'Number of active requests'
)

token_usage = Counter(
    'proxy_tokens_total',
    'Total number of tokens used',
    ['model', 'token_type']  # token_type: input/output
)

websocket_status = Gauge(
    'proxy_websocket_connected',
    'WebSocket connection status (1=connected, 0=disconnected)'
)

error_count = Counter(
    'proxy_errors_total',
    'Total number of errors',
    ['error_type', 'model']
)

model_registry_gauge = Gauge(
    'proxy_models_registered',
    'Number of registered models'
)

# --- Request Details Storage ---
@dataclass
class RequestDetails:
    """"Details of the storage request"""
    request_id: str
    timestamp: float
    model: str
    status: str
    duration: float
    input_tokens: int
    output_tokens: int
    error: Optional[str]
    request_params: dict
    request_messages: list
    response_content: str
    headers: dict
    
class RequestDetailsStorage:
    """Storage of management request details"""
    def __init__(self, max_size: int = Config.MAX_REQUEST_DETAILS):
        self.details: Dict[str, RequestDetails] = {}
        self.order: deque = deque(maxlen=max_size)
        self._lock = threading.Lock()
    
    def add(self, details: RequestDetails):
        """Add request details"""
        with self._lock:
            if details.request_id in self.details:
                return
            
            if len(self.order) >= self.order.maxlen:
                oldest_id = self.order[0]
                if oldest_id in self.details:
                    del self.details[oldest_id]
            
            self.details[details.request_id] = details
            self.order.append(details.request_id)
    
    def get(self, request_id: str) -> Optional[RequestDetails]:
        """Get request details"""
        with self._lock:
            return self.details.get(request_id)
    
    def get_recent(self, limit: int = 100) -> list:
        """Get recent request details"""
        with self._lock:
            recent_ids = list(self.order)[-limit:]
            return [self.details[id] for id in reversed(recent_ids) if id in self.details]

request_details_storage = RequestDetailsStorage()

class LogManager:
    def __init__(self):
        Config.LOG_DIR.mkdir(parents=True, exist_ok=True)
        
        self.request_log_path = Config.LOG_DIR / Config.REQUEST_LOG_FILE
        self.error_log_path = Config.LOG_DIR / Config.ERROR_LOG_FILE
        self._lock = threading.Lock()
        
        # Create empty log files if they don't exist
        self.request_log_path.touch(exist_ok=True)
        self.error_log_path.touch(exist_ok=True)
        
        self._check_and_rotate()
    
    def _check_and_rotate(self):
        for log_path in [self.request_log_path, self.error_log_path]:
            if log_path.exists() and log_path.stat().st_size > Config.MAX_LOG_SIZE:
                self._rotate_log(log_path)
    
    def _rotate_log(self, log_path: Path):
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        rotated_path = log_path.with_suffix(f".{timestamp}.jsonl")
        
        shutil.move(log_path, rotated_path)
        
        with open(rotated_path, 'rb') as f_in:
            with gzip.open(f"{rotated_path}.gz", 'wb') as f_out:
                shutil.copyfileobj(f_in, f_out)
        
        rotated_path.unlink()
        
        self._cleanup_old_logs()
    
    def _cleanup_old_logs(self):
        log_files = sorted(Config.LOG_DIR.glob("*.jsonl.gz"), key=lambda x: x.stat().st_mtime)
        
        while len(log_files) > Config.MAX_LOG_FILES:
            oldest_file = log_files.pop(0)
            oldest_file.unlink()
            logging.info(f": {oldest_file}")
    
    def write_request_log(self, log_entry: dict):
        with self._lock:
            self._check_and_rotate()
            with open(self.request_log_path, 'a', encoding='utf-8') as f:
                f.write(json.dumps(log_entry, ensure_ascii=False) + '\n')
    
    def write_error_log(self, log_entry: dict):
        with self._lock:
            self._check_and_rotate()
            with open(self.error_log_path, 'a', encoding='utf-8') as f:
                f.write(json.dumps(log_entry, ensure_ascii=False) + '\n')
    
    def read_request_logs(self, limit: int = 100, offset: int = 0, model: str = None) -> list:
        logs = []
        
        if self.request_log_path.exists():
            with open(self.request_log_path, 'r', encoding='utf-8') as f:
                all_lines = f.readlines()
                
                for line in reversed(all_lines):
                    try:
                        log = json.loads(line.strip())
                        if log.get('type') == 'request_end':  
                            if model and log.get('model') != model:
                                continue
                            logs.append(log)
                            if len(logs) >= limit + offset:
                                break
                    except json.JSONDecodeError:
                        continue
        
        return logs[offset:offset + limit]
    
    def read_error_logs(self, limit: int = 50) -> list:
        logs = []
        
        if self.error_log_path.exists():
            with open(self.error_log_path, 'r', encoding='utf-8') as f:
                all_lines = f.readlines()
                
                for line in reversed(all_lines[-limit:]):
                    try:
                        log = json.loads(line.strip())
                        logs.append(log)
                    except json.JSONDecodeError:
                        continue
        
        return logs

log_manager = LogManager()

class PerformanceMonitor:
    
    def __init__(self):
        self.request_times = deque(maxlen=1000)
        self.model_stats = defaultdict(lambda: {'count': 0, 'errors': 0})
    
    def record_request(self, model: str, duration: float, success: bool):
        self.request_times.append(duration)
        self.model_stats[model]['count'] += 1
        if not success:
            self.model_stats[model]['errors'] += 1
    
    def get_stats(self) -> dict:
        if not self.request_times:
            return {'avg_response_time': 0}
        return {
            'avg_response_time': sum(self.request_times) / len(self.request_times)
        }

    def get_model_stats(self) -> dict:
        """Get statistics per model"""
        result = {}
        for model, stats in self.model_stats.items():
            count = stats['count']
            errors = stats['errors']
            result[model] = {
                'total_requests': count,
                'errors': errors,
                'error_rate': (errors / count * 100) if count > 0 else 0,
                'qps': count
            }
        return result

performance_monitor = PerformanceMonitor()

@dataclass
class RealtimeStats:
    active_requests: Dict[str, dict] = field(default_factory=dict)
    recent_requests: deque = field(default_factory=lambda: deque(maxlen=Config.MAX_LOG_MEMORY_ITEMS))
    recent_errors: deque = field(default_factory=lambda: deque(maxlen=50))
    model_usage: Dict[str, dict] = field(default_factory=lambda: defaultdict(lambda: {
        'requests': 0, 'tokens': 0, 'errors': 0, 'avg_duration': 0
    }))
    
    def cleanup_old_requests(self):
        current_time = time.time()
        timeout_requests = []
        
        for req_id, req in self.active_requests.items():
            if current_time - req['start_time'] > Config.REQUEST_TIMEOUT_SECONDS:
                timeout_requests.append(req_id)
        
        for req_id in timeout_requests:
            logging.warning(f"Warning: {req_id}")
            del self.active_requests[req_id]

realtime_stats = RealtimeStats()

async def periodic_cleanup():
    while not SHUTTING_DOWN:
        try:
            realtime_stats.cleanup_old_requests()
            
            log_manager._check_and_rotate()
            
            active_requests_gauge.set(len(realtime_stats.active_requests))
            model_registry_gauge.set(len(MODEL_REGISTRY))
            
            logging.info(f"Cleanup task completed. Active requests: {len(realtime_stats.active_requests)}")
            
        except Exception as e:
            logging.error(f"Error: {e}")
        
        await asyncio.sleep(Config.CLEANUP_INTERVAL)

# --- Custom Streaming Response with Immediate Flush ---
class ImmediateStreamingResponse(StreamingResponse):
    """Custom streaming response that forces immediate flushing of chunks"""

    async def stream_response(self, send: typing.Callable) -> None:
        await send({
            "type": "http.response.start",
            "status": self.status_code,
            "headers": self.raw_headers,
        })

        async for chunk in self.body_iterator:
            if chunk:
                # Send the chunk immediately
                await send({
                    "type": "http.response.body",
                    "body": chunk.encode(self.charset) if isinstance(chunk, str) else chunk,
                    "more_body": True,
                })
                # Force a small delay to ensure the chunk is sent
                await asyncio.sleep(0)

        # Send final empty chunk to close the stream
        await send({
            "type": "http.response.body",
            "body": b"",
            "more_body": False,
        })

# --- Logging Functions ---
def log_request_start(request_id: str, model: str, params: dict, messages: list = None, api_key: str = None):
    request_info = {
        'id': request_id,
        'model': model,
        'start_time': time.time(),
        'status': 'active',
        'params': params,
        'messages': messages or [],
        'api_key': api_key
    }
    
    realtime_stats.active_requests[request_id] = request_info
    
    log_entry = {
        'type': 'request_start',
        'timestamp': time.time(),
        'request_id': request_id,
        'model': model,
        'params': params,
        'api_key': api_key
    }
    log_manager.write_request_log(log_entry)
    
def log_request_end(request_id: str, success: bool, input_tokens: int = 0, 
                   output_tokens: int = 0, error: str = None, response_content: str = "", api_key: str = None):
    if request_id not in realtime_stats.active_requests:
        return
        
    req = realtime_stats.active_requests[request_id]
    duration = time.time() - req['start_time']
    
    req['status'] = 'success' if success else 'failed'
    req['duration'] = duration
    req['input_tokens'] = input_tokens
    req['output_tokens'] = output_tokens
    req['error'] = error
    req['end_time'] = time.time()
    req['response_content'] = response_content
    
    realtime_stats.recent_requests.append(req.copy())
    
    model = req['model']
    stats = realtime_stats.model_usage[model]
    stats['requests'] += 1
    if success:
        stats['tokens'] += input_tokens + output_tokens
    else:
        stats['errors'] += 1
    
    performance_monitor.record_request(model, duration, success)
    
    request_count.labels(model=model, status='success' if success else 'failed', type='chat').inc()
    request_duration.labels(model=model, type='chat').observe(duration)
    token_usage.labels(model=model, token_type='input').inc(input_tokens)
    token_usage.labels(model=model, token_type='output').inc(output_tokens)
    
    details = RequestDetails(
        request_id=request_id,
        timestamp=req['start_time'],
        model=model,
        status='success' if success else 'failed',
        duration=duration,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        error=error,
        request_params=req.get('params', {}),
        request_messages=req.get('messages', []),
        response_content=response_content[:5000], 
        headers={}
    )
    request_details_storage.add(details)
    
    log_entry = {
        'type': 'request_end',
        'timestamp': time.time(),
        'request_id': request_id,
        'model': model,
        'status': 'success' if success else 'failed',
        'duration': duration,
        'input_tokens': input_tokens,
        'output_tokens': output_tokens,
        'error': error,
        'params': req.get('params', {}),
        'api_key': api_key or req.get('api_key')  # Use passed api_key or get from request info
    }
    log_manager.write_request_log(log_entry)

    del realtime_stats.active_requests[request_id]

def log_error(request_id: str, error_type: str, error_message: str, stack_trace: str = ""):
    """记录错误日志"""
    error_data = {
        'timestamp': time.time(),
        'request_id': request_id,
        'error_type': error_type,
        'error_message': error_message,
        'stack_trace': stack_trace
    }
    
    realtime_stats.recent_errors.append(error_data)
    
    # Prometheus
    model = realtime_stats.active_requests.get(request_id, {}).get('model', 'unknown')
    error_count.labels(error_type=error_type, model=model).inc()
   
    log_manager.write_error_log(error_data)

# --- Model Registry and Mapping ---
MODEL_ALIASES = {}
MODEL_REGISTRY = {}  # Will be populated dynamically

def resolve_model_name(model_name: str) -> str:
    """Resolve alias to actual model name"""
    return MODEL_ALIASES.get(model_name, model_name)

def load_models_from_file():
    """Load models from allowed_models.txt into MODEL_REGISTRY"""
    global MODEL_REGISTRY
    global MODEL_ALIASES
    
    try:
        with open("allowed_models.txt", "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#'):
                    # Check for alias mapping (alias:actual_name)
                    if ':' in line:
                        alias, actual_name = line.split(':', 1)
                        alias = alias.strip()
                        actual_name = actual_name.strip()
                        MODEL_ALIASES[alias] = actual_name
                        model_name = alias  # Use alias as the display name
                    else:
                        model_name = line
                    
                    MODEL_REGISTRY[model_name] = {
                        "type": "chat",
                        "capabilities": {
                            "outputCapabilities": {}
                        }
                    }
        logging.info(f"Loaded {len(MODEL_REGISTRY)} models from allowed_models.txt")
        if MODEL_ALIASES:
            logging.info(f"Loaded {len(MODEL_ALIASES)} model aliases")
    except FileNotFoundError:
        logging.warning("allowed_models.txt not found")

# --- Global State ---
response_channels: dict[str, asyncio.Queue] = {}  # Keep for backward compatibility
background_tasks: Set[asyncio.Task] = set()
SHUTTING_DOWN = False
startup_time = time.time()  # 服务器启动时间

# --- FastAPI App and Lifespan ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    global MODEL_REGISTRY, startup_time
    startup_time = time.time()

    Config.load_endpoints()

    load_models_from_file()
    logging.info(f" {len(MODEL_REGISTRY)} ")

    reset_task = asyncio.create_task(scheduled_daily_reset())
    background_tasks.add(reset_task)

    cleanup_task = asyncio.create_task(periodic_cleanup())
    background_tasks.add(cleanup_task)

    try:
        yield
    finally:
        global SHUTTING_DOWN
        SHUTTING_DOWN = True
        logging.info(f"Lifespan: Server is shutting down. Cancelling. {len(background_tasks)} background tasks...")

        # Cancel all background tasks
        cancelled_tasks = []
        for task in list(background_tasks):
            if not task.done():
                logging.info(f"Lifespan: Cancelling task: {task}")
                task.cancel()
                cancelled_tasks.append(task)

        # Wait for cancelled tasks to finish
        if cancelled_tasks:
            logging.info(f"Lifespan: Waiting {len(cancelled_tasks)} to complete the cancelled task...")
            results = await asyncio.gather(*cancelled_tasks, return_exceptions=True)
            for i, result in enumerate(results):
                if isinstance(result, Exception):
                    logging.info(f"Lifespan: Task {i} completed, Result: {type(result).__name__}")
                else:
                    logging.info(f"Lifespan: Task {i} completed, result is normal.")

        logging.info("Lifespan: All background tasks have been cancelled. Closure complete.。")


app = FastAPI(lifespan=lifespan)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Simplified API Handler ---
@app.post("/v1/chat/completions")
async def chat_completions(request: Request, api_key: str = Depends(verify_api_key)):
    try:
        api_key_manager.check_for_generation(api_key)
    except HTTPException as e:
        status_code = getattr(e, 'status', 500)
        return JSONResponse({"error": str(e)}, status_code=status_code)
    
    openai_req = await request.json()
    request_id = str(uuid.uuid4())
    is_streaming = openai_req.get("stream", True)
    model_name = openai_req.get("model")

    # Validate model
    model_info = MODEL_REGISTRY.get(model_name)
    if not model_info:
        raise HTTPException(status_code=404, detail=f"Model '{model_name}' not found.")

    # Remove unwanted parameters before sending to backend
    params_to_exclude = ["frequency_penalty", "presence_penalty", "top_p"]
    for param in params_to_exclude:
        openai_req.pop(param, None)  # Use pop with None default to avoid KeyError
    
    # Log request start for stats
    request_params = {
        "temperature": openai_req.get("temperature"),
        "max_tokens": openai_req.get("max_tokens"),
        "streaming": is_streaming
    }
    messages = openai_req.get("messages", [])
    log_request_start(request_id, model_name, request_params, messages, api_key)
    
    try:
        if is_streaming:
            return StreamingResponse(
                stream_from_backend(request_id, openai_req, model_name, api_key),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no"
                }
            )
        else:
            # Non-streaming response
            response_data = await make_backend_request(request_id, openai_req, model_name, api_key)
            return response_data
            
    except (Exception, HTTPException) as e:
        log_request_end(request_id, False, 0, 0, str(e))
        logging.error(f"API [ID: {request_id}]: Exception: {e}", exc_info=True)

        return JSONResponse({"error": "Error: Encountered an error. Please try again later or contact the admin."}, status_code=500)

def get_temperature(openai_req: dict):
    temp = openai_req.get("temperature")
    if temp is None:
        return None  # or some default value like 0.7
    elif temp > 1:
        return 1
    else:
        return temp

def get_endpoint_for_model(model_name: str) -> tuple[str, str, str] | None:
    """
    Get the backend URL, token, and actual model name for a given model.
    Returns (backend_url, backend_token, actual_model) or None if not found.
    """
    # Check for -v{n} suffix pattern
    import re
    actual_model_name = resolve_model_name(model_name)
    match = re.search(r'-v(\d+)$', actual_model_name)
    
    if match:
        version = match.group(1)
        endpoint_key = f"v{version}"
        
        if endpoint_key in Config.ENDPOINTS:
            endpoint = Config.ENDPOINTS[endpoint_key]
            actual_model = actual_model_name.rsplit(f'-v{version}', 1)[0]
            return (endpoint["url"], endpoint["token"], actual_model)
    
    return None

# --- Backend Request Functions ---
async def stream_from_backend(
    request_id: str, 
    openai_req: dict, 
    model_name: str, 
    api_key: str
) -> AsyncGenerator[str, None]:
    """Stream responses directly from the backend"""
    start_time = time.time()
    accumulated_content = ""

    endpoint_info = get_endpoint_for_model(model_name)
    
    if not endpoint_info:
        error_response = {
            "error": {
                "message": "Error 404: Can't find the model you're looking for.",
                "type": "server_error",
                "code": 404
            }
        }
        yield f"data: {json.dumps(error_response)}\n\ndata: [DONE]\n\n"
        return


    backend_url, backend_token, actual_model = endpoint_info
    backend_url = backend_url + "/chat/completions"

    logging.info(f"Request model: {model_name}")
    logging.info(f"Actual model: {actual_model}")
    logging.info(f"Endpoint URL: {backend_url}")

    try:
        async with aiohttp.ClientSession() as session:
            # Prepare the request
            data = {
                "model": actual_model,
                "stream": True,
                "messages": openai_req.get("messages", []),
                "max_tokens": openai_req.get("max_tokens")
            }

            BACKEND_HEADERS = {
                "Authorization": f"Bearer {backend_token}",
                "Content-Type": "application/json"
            }
            
            # Remove None values
            data = {k: v for k, v in data.items() if v is not None}
            
            async with session.post(
                backend_url,
                headers=BACKEND_HEADERS,
                json=data
            ) as response:
                if response.status != 200:
                    error_text = await response.text()
                    logging.error(f"BACKEND [ID: {request_id}]: {error_text}")

                    error_msg = "Encountered an error. Please try again later or contact the admin."
                    
                    # Return OpenAI-formatted error
                    error_response = {
                        "error": {
                            "message": f"Error {response.status}: {error_msg}",
                            "type": "server_error",
                            "code": response.status
                        }
                    }
                    yield f"data: {json.dumps(error_response)}\n\ndata: [DONE]\n\n"
                    return

                # Stream the response
                async for line in response.content:
                    if line:
                        decoded = line.decode("utf-8").strip()
                        if decoded.startswith("data: "):
                            payload = decoded[6:].strip()
                            
                            if payload == "[DONE]":
                                yield "data: [DONE]\n\n"
                                break
                            
                            try:
                                # Parse and accumulate content for logging
                                chunk_data = json.loads(payload)
                                
                                # Check if chunk_data is valid
                                if chunk_data is not None and isinstance(chunk_data, dict):
                                    choices = chunk_data.get("choices", [])
                                    if choices and len(choices) > 0:
                                        delta = choices[0].get("delta", {})
                                        if delta:
                                            content = delta.get("content", "")
                                            if content:
                                                accumulated_content += content
                                
                                # Forward the chunk as-is
                                yield f"data: {payload}\n\n"
                                
                            except json.JSONDecodeError:
                                response_data = {"error": {"message": "Invalid JSON response."}}
                                logging.warning(f"BACKEND [ID: {request_id}]: Invalid JSON in stream.")
                                continue
        
        # Log successful completion
        input_tokens = estimateTokens(json.dumps(openai_req))
        output_tokens = estimateTokens(accumulated_content)
        log_request_end(request_id, True, input_tokens, output_tokens, response_content=accumulated_content, api_key=api_key)
       
    except (Exception, HTTPException) as e:
        logging.error(f"BACKEND [ID: {request_id}]: Stream error: {e}", exc_info=True)

        error_msg = "Encountered an error. Please try again later or contact the admin."
        
        # Return error in OpenAI format
        error_response = {
            "error": {
                "message": error_msg,
                "type": "server_error",
                "code": 500
            }
        }
        yield f"data: {json.dumps(error_response)}\n\ndata: [DONE]\n\n"
        return

        # Log error
        log_error(request_id, type(e).__name__, str(e), traceback.format_exc())
        log_request_end(request_id, False, 0, 0, str(e))

async def make_backend_request(
    request_id: str,
    openai_req: dict,
    model_name: str,
    api_key: str
) -> dict:
    """Make non-streaming request to backend"""
    start_time = time.time()

    endpoint_info = get_endpoint_for_model(model_name)
    
    if not endpoint_info:
        return JSONResponse(
            {"error": "Can't find the model you're looking for."}, 
            status_code=404
        )


    backend_url, backend_token, actual_model = endpoint_info
    backend_url = backend_url + "/chat/completions"

    logging.info(f"Request model: {model_name}")
    logging.info(f"Actual model: {actual_model}")
    logging.info(f"Endpoint URL: {backend_url}")

    try:
        async with aiohttp.ClientSession() as session:
            # Prepare the request
            data = {
                "model": actual_model,
                "stream": False,
                "messages": openai_req.get("messages", []),
                "max_tokens": openai_req.get("max_tokens")
            }

            BACKEND_HEADERS = {
                "Authorization": f"Bearer {backend_token}",
                "Content-Type": "application/json"
            }
            
            # Remove None values
            data = {k: v for k, v in data.items() if v is not None}
            
            async with session.post(
                backend_url,
                headers=BACKEND_HEADERS,
                json=data
            ) as response:
                if response.status != 200:
                    error_text = await response.text()
                    logging.error(f"BACKEND [ID: {request_id}]: {error_text}")

                    error_msg = "Encountered an error. Please try again later or contact the admin."

                    return JSONResponse({"error": error_msg}, status_code=response.status)

                # Get response text first, then parse as JSON
                response_text = await response.text()
                
                try:
                    response_data = json.loads(response_text)
                except json.JSONDecodeError:
                    error_msg = "Invalid JSON response."
                    return JSONResponse({"error": error_msg}, status_code=500)
                
                # Log successful completion
                content = response_data.get("choices", [{}])[0].get("message", {}).get("content", "")
                input_tokens = estimateTokens(json.dumps(openai_req))
                output_tokens = estimateTokens(content)
                log_request_end(request_id, True, input_tokens, output_tokens, content, api_key)
                
                return response_data
                
    except (Exception, HTTPException) as e:
        logging.error(f"BACKEND [ID: {request_id}]: Stream error: {e}", exc_info=True)
        
        error_msg = "Encountered an error. Please try again later or contact the admin."
        
        return JSONResponse({"error": error_msg}, status_code=response.status)

        # Log error
        log_error(request_id, type(e).__name__, str(e), traceback.format_exc())
        log_request_end(request_id, False, 0, 0, str(e))

# Simple token estimation function
def estimateTokens(text: str) -> int:
    if not text:
        return 0
    return len(str(text)) // 4

#############################################
################# ENDPOINTS #################
#############################################

@app.get("/api/stats/summary")
async def get_stats_summary():
    current_time = time.time()
    day_ago = current_time - 86400
    
    logs = log_manager.read_request_logs(limit=10000)
    recent_24h_logs = [log for log in logs if log.get('timestamp', 0) > day_ago]

    total_requests = len(logs)
    daily_requests = len(recent_24h_logs)

    successful = sum(1 for log in recent_24h_logs if log.get('status') == 'success')
    failed = total_requests - successful
    
    total_input_tokens = sum(log.get('input_tokens', 0) for log in logs)
    total_output_tokens = sum(log.get('output_tokens', 0) for log in logs)

    daily_input_tokens = sum(log.get('input_tokens', 0) for log in recent_24h_logs)
    daily_output_tokens = sum(log.get('output_tokens', 0) for log in recent_24h_logs)
    
    durations = [log.get('duration', 0) for log in recent_24h_logs if log.get('duration', 0) > 0]
    avg_duration = sum(durations) / len(durations) if durations else 0

    all_api_keys = list(api_key_manager.keys)

    
    return {
        "total_requests": total_requests,
        "daily_requests": daily_requests,
        "successful": successful,
        "failed": failed,
        "total_input_tokens": total_input_tokens,
        "total_output_tokens": total_output_tokens,
        "daily_input_tokens": daily_input_tokens,
        "daily_output_tokens": daily_output_tokens,
        "avg_duration": avg_duration,
        "success_rate": (successful / total_requests * 100) if total_requests > 0 else 0,
        "uptime": time.time() - startup_time,
        "total_api_keys": len(all_api_keys)
    }

# Endpoint to verify and get usage without authentication header
@app.post("/api/usage")
async def check_usage(request: Request, api_key: str = Depends(verify_api_key_for_stats)):
    if not api_key:
        raise HTTPException(status_code=400, detail="API key required")
    
    stats = api_key_manager.get_usage_stats(api_key)
    
    return {
        "usage": stats
    }

@app.get("/v1/models")
async def get_models():  
    """Lists available models from a text file in an OpenAI-compatible format."""  
      
    models_data = []
    model_aliases = {}  # Store alias -> actual_name mapping
    
    try:  
        with open("allowed_models.txt", "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#'):
                    # Check for alias mapping (using ":" or "=")
                    if ':' in line:
                        alias, actual_name = line.split(':', 1)
                        alias = alias.strip()
                        actual_name = actual_name.strip()
                        model_aliases[alias] = actual_name
                        display_name = alias  # Show the clean alias to users
                    else:
                        display_name = line
                        
                    models_data.append({  
                        "id": display_name,  
                        "object": "model",  
                        "created": int(time.time()),  
                        "owned_by": "kratos",  
                        "type": "chat"
                    })
    except FileNotFoundError:  
        # If no file exists, return models from registry
        for model_name, model_info in MODEL_REGISTRY.items():
            models_data.append({  
                "id": model_name,  
                "object": "model",  
                "created": int(time.time()),  
                "owned_by": "kratos",  
                "type": model_info.get("type", "chat")  
            })
      
    return {  
        "object": "list",  
        "data": models_data  
    }

@app.get("/models", response_class=HTMLResponse)
async def user_usage():
    html_file_path = Path(__file__).parent / "html/models.html"
    error_html_file_path = Path(__file__).parent / "html/404.html"
    
    if not html_file_path.exists():
        with open(error_html_file_path, 'r', encoding='utf-8') as f:
            error_content = f.read()
        return HTMLResponse(
            content=error_content,
            status_code=404
        )
    
    with open(html_file_path, 'r', encoding='utf-8') as f:
        html_content = f.read()
    
    return HTMLResponse(content=html_content)

@app.get("/v1")
async def redirect_v1():
    return RedirectResponse(url="/")

@app.get("/", response_class=HTMLResponse)
async def monitor_main():
    html_file_path = Path(__file__).parent / "html/index.html"
    error_html_file_path = Path(__file__).parent / "html/404.html"
    
    if not html_file_path.exists():
        with open(error_html_file_path, 'r', encoding='utf-8') as f:
            error_content = f.read()
        return HTMLResponse(
            content=error_content,
            status_code=404
        )
    
    with open(html_file_path, 'r', encoding='utf-8') as f:
        html_content = f.read()
    
    return HTMLResponse(content=html_content)

# -------------------------------------------
# ----------------- USAGE -------------------  
# -------------------------------------------

@app.get("/usage", response_class=HTMLResponse)
async def user_usage():
    html_file_path = Path(__file__).parent / "html/user_usage.html"
    error_html_file_path = Path(__file__).parent / "html/404.html"
    
    if not html_file_path.exists():
        with open(error_html_file_path, 'r', encoding='utf-8') as f:
            error_content = f.read()
        return HTMLResponse(
            content=error_content,
            status_code=404
        )
    
    with open(html_file_path, 'r', encoding='utf-8') as f:
        html_content = f.read()
    
    return HTMLResponse(content=html_content)

@app.get("/admin/login", response_class=HTMLResponse)
async def login_admin_usage():
    html_file_path = Path(__file__).parent / "html/login_admin.html"
    error_html_file_path = Path(__file__).parent / "html/404.html"
    
    if not html_file_path.exists():
        with open(error_html_file_path, 'r', encoding='utf-8') as f:
            error_content = f.read()
        return HTMLResponse(
            content=error_content,
            status_code=404
        )
    
    with open(html_file_path, 'r', encoding='utf-8') as f:
        html_content = f.read()
    
    return HTMLResponse(content=html_content)

@app.get("/admin/usage", response_class=HTMLResponse)
async def admin_usage():
    html_file_path = Path(__file__).parent / "html/admin_usage.html"
    error_html_file_path = Path(__file__).parent / "html/404.html"
    
    if not html_file_path.exists():
        with open(error_html_file_path, 'r', encoding='utf-8') as f:
            error_content = f.read()
        return HTMLResponse(
            content=error_content,
            status_code=404
        )
    
    with open(html_file_path, 'r', encoding='utf-8') as f:
        html_content = f.read()
    
    return HTMLResponse(content=html_content)

# API endpoint for dashboard data
@app.get("/admin/usage-data")
async def get_admin_usage_data(authorization: bool = Depends(verify_master_key)):
    """Get usage data for admin dashboard"""
    
    # Get all API keys and their usage
    all_api_keys = api_key_manager.keys
    dashboard_data = []
    
    for api_key in all_api_keys:
        stats = api_key_manager.get_usage_stats(api_key)
        dashboard_data.append({
            "name": api_key_manager.get_key_name(api_key),
            "api_key": api_key[:5] + "..." if len(api_key) > 5 else api_key,
            "total_requests": stats["total_requests"],
            "daily_requests": stats.get("daily_requests", 0),
            "total_input_tokens": stats.get("total_input_tokens", 0),
            "total_output_tokens": stats.get("total_output_tokens", 0),
            "daily_input_tokens": stats.get("daily_input_tokens", 0),
            "daily_output_tokens": stats.get("daily_output_tokens", 0),
        })
    
    # Sort by total requests
    dashboard_data.sort(key=lambda x: x["daily_requests"], reverse=True)

    # Get recent logs
    logs = log_manager.read_request_logs(limit=100)
    
    # Filter for completed requests and format them
    formatted_logs = []
    for log in logs:
        if log.get('type') == 'request_end' and log.get('status') == 'success':
            api_key = log.get('api_key', 'Unknown')
            formatted_logs.append({
                "timestamp": log.get('timestamp', 0),
                "request_id": log.get('request_id', ''),
                "name": api_key_manager.get_key_name(api_key) if api_key != 'Unknown' else 'Unknown',
                "api_key": api_key[:5] + "..." if len(api_key) > 5 else api_key,
                "model": log.get('model', 'Unknown'),
                "input_tokens": log.get('input_tokens', 0),
                "output_tokens": log.get('output_tokens', 0),
                "total_tokens": log.get('input_tokens', 0) + log.get('output_tokens', 0),
                "duration": log.get('duration', 0)
            })
    
    # Sort by timestamp (most recent first) and take top 5
    formatted_logs.sort(key=lambda x: x['timestamp'], reverse=True)
    recent_logs_data = formatted_logs[:50]

    # Calculate totals
    totals = {
        "total_api_keys": len(all_api_keys),
        "total_requests": sum(d["total_requests"] for d in dashboard_data),
        "daily_requests": sum(d["daily_requests"] for d in dashboard_data),
        "total_input_tokens": sum(d["total_input_tokens"] for d in dashboard_data),
        "total_output_tokens": sum(d["total_output_tokens"] for d in dashboard_data),
        "daily_input_tokens": sum(d["daily_input_tokens"] for d in dashboard_data),
        "daily_output_tokens": sum(d["daily_output_tokens"] for d in dashboard_data),
    }
    
    return {
        "summary": totals,
        "api_keys": dashboard_data,
        "recent_logs": recent_logs_data
    }

# -------------------------------------------
# ----------- API KEY MANAGER ---------------  
# -------------------------------------------

@app.get("/admin/manager", response_class=HTMLResponse)
async def admin_manager():
    html_file_path = Path(__file__).parent / "html/admin_manager.html"
    error_html_file_path = Path(__file__).parent / "html/404.html"
    
    if not html_file_path.exists():
        with open(error_html_file_path, 'r', encoding='utf-8') as f:
            error_content = f.read()
        return HTMLResponse(
            content=error_content,
            status_code=404
        )
    
    with open(html_file_path, 'r', encoding='utf-8') as f:
        html_content = f.read()
    
    return HTMLResponse(content=html_content)

@app.get("/admin/keys")
async def get_api_keys(
    authorized: bool = Depends(verify_master_key)
):
    """Get all API keys"""
    try:
        keys = api_key_manager.get_keys()
        return {"keys": keys}
    except Exception as e:
        logging.error(f"Error loading keys: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/admin/keys/add")
async def add_api_key(
    request: dict,
    authorized: bool = Depends(verify_master_key)
):
    """Add a new API key with optional RPD limit"""
    try:
        api_key = request.get('api_key', '').strip()
        name = request.get('name', '').strip()
        
        if not api_key or not name:
            raise HTTPException(status_code=400, detail="API key and name are required")
        
        # Check if key already exists (referencing existing logic in context [1])
        if api_key in api_key_manager.keys:
            raise HTTPException(status_code=400, detail="API key already exists")
        
        api_key_manager.add_key(api_key, name)
        logging.info(f"Added new API key: {name}")
        
        return {
            "message": "API key added successfully"
        }
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"Error adding key: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# Update API key name
@app.put("/admin/keys/update")
async def update_api_key(
    request: dict,
    authorized: bool = Depends(verify_master_key)
):
    """Update an API key's name"""
    try:
        new_name = request.get('name', '').strip()
        api_key = request.get('api_key', '').strip()
        rpd = request.get('rpd', '')
        active = request.get('active', '')

        if not new_name:
            raise HTTPException(status_code=400, detail="Name is required")
        if not rpd:
            raise HTTPException(status_code=400, detail="RPD is required")
        
        # Find and update the key
        api_key_manager.update_key(api_key, new_name, rpd, active)
        
        return {"message": "API key updated successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"Error updating key: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# Delete API key
@app.delete("/admin/keys/delete")
async def delete_api_key(
    request: dict,
    authorized: bool = Depends(verify_master_key)
):
    """Delete an API key"""
    try:
        api_key = request.get('api_key', '').strip()

        keys = api_key_manager.get_keys()
        
        api_key_manager.remove_key(api_key)
        logging.info(f"Deleted API key: {api_key}")
        
        return {"message": "API key deleted successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"Error deleting key: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/admin/reload")
async def reload_server_config(authorized: bool = Depends(verify_master_key)):
    load_environ()
    api_key_manager.load_keys()
    load_models_from_file()
    api_key_manager.reset_daily()

    return {"status": "success", "message": "Configuration, keys and models reloaded."}

print("\n" + "="*60)
print("="*20 + " "*5 + "NORE PROXY" + " "*5 + "="*20)
print("="*60)
print(f"  Launched at:    {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
print(f"  Host:          {Config.HOST}")
print(f"  Port:          {Config.PORT}")
print(f"  Rate Limits:   {Config.RPM_DEFAULT} RPM / {Config.RPD_DEFAULT}  RPD")
# Count configured endpoints
endpoints = sum(1 for i in range(1, 11) if os.getenv(f'V{i}_URL'))
print(f"  Endpoints:     {endpoints} configured")
print(f"  Main Page:     http://localhost:{Config.PORT}")
print(f"  Login:         http://localhost:{Config.PORT}/admin/login")
print(f"  API Base URL:  http://localhost:{Config.PORT}/v1")
print("="*60)
print("="*60)
print(" "*60)
if __name__ == "__main__":
    uvicorn.run(app, host=Config.HOST, port=Config.PORT)
