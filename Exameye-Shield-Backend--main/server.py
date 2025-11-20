"""
FastAPI Server for AI Proctoring with WebSocket Support
Integrates YOLOv8n and MediaPipe for real-time exam monitoring
"""
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from typing import Dict, List
import base64
import cv2
import numpy as np
from datetime import datetime
import asyncio
import logging
import json
from supabase import create_client, Client
import os
from dotenv import load_dotenv
from pathlib import Path
import uuid
import re

# Load environment variables
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

from proctoring_service import ProctoringService
from grading_service import grading_service
from models import (
    FrameProcessRequest,
    FrameProcessResponse,
    CalibrationRequest,
    CalibrationResponse,
    EnvironmentCheckRequest,
    EnvironmentCheck,
    ViolationDetail
)

# Path to built frontend (Vite)
FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastAPI
app = FastAPI(title="AI Proctoring Service", version="1.0.0")

# Serve Vite static assets (JS/CSS under /assets)
if FRONTEND_DIST.exists():
    app.mount(
        "/assets",
        StaticFiles(directory=FRONTEND_DIST / "assets"),
        name="assets",
    )

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize Supabase client
supabase_url = os.environ.get("SUPABASE_URL", "https://ukwnvvuqmiqrjlghgxnf.supabase.co")
supabase_key = os.environ.get("SUPABASE_KEY", "")
supabase: Client = create_client(supabase_url, supabase_key)

# Initialize Proctoring Service
proctoring_service = ProctoringService()

# Helper function to validate and convert UUID
def validate_uuid(value):
    """Validate if a value is a valid UUID, return it or None"""
    if not value:
        return None
    try:
        # Try to parse as UUID
        uuid.UUID(str(value))
        return str(value)
    except (ValueError, AttributeError):
        # If it's not a valid UUID, return None
        logger.warning(f"Invalid UUID format: {value}, using None instead")
        return None

# Active WebSocket connections
active_connections: Dict[str, WebSocket] = {}

def _upload_snapshot_and_get_url(
    supabase: Client,
    exam_id: str,
    student_id: str,
    violation_type: str,
    snapshot_base64: str
):
    """
    Uploads a base64 JPEG snapshot to Supabase Storage bucket 'violation-evidence'
    and returns a public URL. Returns None on failure.
    """
    try:
        if not snapshot_base64:
            return None
        image_data = base64.b64decode(snapshot_base64.split(',')[1] if ',' in snapshot_base64 else snapshot_base64)
        timestamp = datetime.utcnow().strftime('%Y%m%d_%H%M%S')
        filename = f"{exam_id}/{student_id}_{violation_type}_{timestamp}.jpg"
        # Upload
        supabase.storage.from_('violation-evidence').upload(
            filename,
            image_data,
            file_options={"content-type": "image/jpeg"}
        )
        public_url = supabase.storage.from_('violation-evidence').get_public_url(filename)
        return public_url
    except Exception as e:
        logger.error(f"Snapshot upload failed: {e}")
        return None

@app.get("/")
async def root():
    """
    Basic health/info endpoint. On Railway, the React UI will be served
    by the catch‑all route below once the frontend is built.
    """
    return {
        "service": "AI Proctoring Service",
        "status": "running",
        "version": "1.0.0",
        "models": {
            "yolo": proctoring_service.yolo_model is not None,
            "mediapipe": proctoring_service.mp_face_mesh is not None
        }
    }

@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "models_loaded": proctoring_service.yolo_model is not None
    }


# Catch‑all route to serve React app (index.html) from Vite build
@app.get("/{full_path:path}")
async def serve_frontend(full_path: str):
    index_file = FRONTEND_DIST / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    # Fallback JSON if frontend hasn't been built/deployed yet
    return {"detail": "Frontend build not found", "path": full_path}

@app.post("/api/grade-exam")
async def grade_exam(request: dict):
    """
    Auto-grade exam by comparing student answers with correct answers
    Request: {
        exam_id: str,
        student_id: str,
        answers: [{question_number: int, answer: str}]
    }
    """
    try:
        exam_id = request.get('exam_id')
        student_id = request.get('student_id')
        student_answers = request.get('answers', [])
        
        logger.info(f"📝 Grading exam: exam_id={exam_id}, student_id={student_id}, answers={len(student_answers)}")
        
        # Get questions with correct answers from Supabase
        exam_response = supabase.table('exams').select('exam_template_id').eq('id', exam_id).single().execute()
        exam_template_id = exam_response.data['exam_template_id']
        
        questions_response = supabase.table('exam_questions').select('question_number, correct_answer, points').eq('exam_template_id', exam_template_id).execute()
        questions = questions_response.data
        
        # Grade the exam
        total_score, max_score, results = grading_service.grade_exam(student_answers, questions)
        percentage = grading_service.calculate_percentage(total_score, max_score)
        grade_letter = grading_service.get_grade_letter(percentage)
        
        # Update exam with score
        supabase.table('exams').update({
            'total_score': total_score,
            'max_score': max_score,
            'graded': True,
            'graded_at': datetime.utcnow().isoformat()
        }).eq('id', exam_id).execute()
        
        logger.info(f"✅ Grading complete: {total_score}/{max_score} ({percentage}%) - Grade: {grade_letter}")
        
        return {
            'success': True,
            'total_score': total_score,
            'max_score': max_score,
            'percentage': percentage,
            'grade_letter': grade_letter,
            'results': results
        }
    
    except Exception as e:
        logger.error(f"❌ Grading error: {e}")
        return {'success': False, 'error': str(e)}

@app.post("/api/calibrate", response_model=CalibrationResponse)
async def calibrate(request: CalibrationRequest):
    """Calibrate head pose for a student"""
    try:
        # Decode base64 frame
        frame_data = base64.b64decode(request.frame_base64.split(',')[1] if ',' in request.frame_base64 else request.frame_base64)
        nparr = np.frombuffer(frame_data, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        if frame is None:
            return CalibrationResponse(success=False, message="Invalid frame data")
        
        # Get calibration values
        result = proctoring_service.calibrate_head_pose(frame)
        
        if result['success']:
            return CalibrationResponse(
                success=True,
                pitch=result['pitch'],
                yaw=result['yaw'],
                message="Calibration successful"
            )
        else:
            return CalibrationResponse(
                success=False,
                message=result.get('message', 'Calibration failed')
            )
    except Exception as e:
        logger.error(f"Calibration error: {e}")
        return CalibrationResponse(success=False, message=str(e))

@app.post("/api/environment-check", response_model=EnvironmentCheck)
async def check_environment(request: EnvironmentCheckRequest):
    """Check lighting and face detection for environment verification"""
    try:
        # Decode base64 frame
        frame_data = base64.b64decode(request.frame_base64.split(',')[1] if ',' in request.frame_base64 else request.frame_base64)
        nparr = np.frombuffer(frame_data, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        if frame is None:
            return EnvironmentCheck(
                lighting_ok=False,
                face_detected=False,
                face_centered=False,
                multiple_faces_detected=False,
                message="Invalid frame data"
            )
        
        # Check environment
        result = proctoring_service.check_environment(frame)
        
        # Also check for multiple faces using process_frame
        try:
            detection_result = proctoring_service.process_frame(
                frame=frame,
                calibrated_pitch=0.0,
                calibrated_yaw=0.0,
                session_id="face_registration"  # Dummy session for face registration
            )
            multiple_faces = detection_result.get('multiple_faces', False)
        except Exception as e:
            logger.warning(f"Multiple face check failed: {e}")
            # Default to False if check fails (lenient)
            multiple_faces = False
        
        return EnvironmentCheck(
            lighting_ok=result['lighting_ok'],
            face_detected=result['face_detected'],
            face_centered=result['face_centered'],
            multiple_faces_detected=multiple_faces,
            message=result['message']
        )
    except Exception as e:
        logger.error(f"Environment check error: {e}")
        return EnvironmentCheck(
            lighting_ok=False,
            face_detected=False,
            face_centered=False,
            multiple_faces_detected=False,
            message=str(e)
        )

@app.post("/api/process-frame", response_model=FrameProcessResponse)
async def process_frame(request: FrameProcessRequest):
    """Process a single frame for violations"""
    try:
        # Decode base64 frame
        frame_data = base64.b64decode(request.frame_base64.split(',')[1] if ',' in request.frame_base64 else request.frame_base64)
        nparr = np.frombuffer(frame_data, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        if frame is None:
            raise HTTPException(status_code=400, detail="Invalid frame data")
        
        # Process frame
        result = proctoring_service.process_frame(
            frame,
            request.session_id,
            request.calibrated_pitch,
            request.calibrated_yaw
        )
        
        # Convert violations to response format
        violations = [
            ViolationDetail(
                type=v['type'],
                severity=v['severity'],
                message=v['message'],
                confidence=v.get('confidence')
            )
            for v in result['violations']
        ]
        
        return FrameProcessResponse(
            timestamp=datetime.utcnow().isoformat(),
            violations=violations,
            head_pose=result.get('head_pose'),
            face_count=result['face_count'],
            looking_away=result['looking_away'],
            multiple_faces=result['multiple_faces'],
            no_person=result['no_person'],
            phone_detected=result['phone_detected'],
            book_detected=result['book_detected'],
            snapshot_base64=result.get('snapshot_base64')
        )
    except Exception as e:
        logger.error(f"Frame processing error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# Violation cooldown tracking: prevent duplicate violations of same type
# Format: {session_id: {violation_type: last_timestamp}}
violation_cooldowns: Dict[str, Dict[str, float]] = {}
VIOLATION_COOLDOWN_SEC = 10.0  # Don't log same violation type within 10 seconds
LOOKING_AWAY_COOLDOWN_SEC = 3.0  # Separate cooldown for looking_away (reduced since detection is now immediate)

@app.websocket("/api/ws/proctoring/{session_id}")
async def websocket_proctoring(websocket: WebSocket, session_id: str):
    """WebSocket endpoint for real-time proctoring"""
    print(f"🔌 WebSocket connection attempt for session: {session_id}")
    logger.info(f"🔌 WebSocket connection attempt for session: {session_id}")
    await websocket.accept()
    active_connections[session_id] = websocket
    print(f"✅ WebSocket connected and accepted: {session_id}")
    logger.info(f"✅ WebSocket connected: {session_id}")
    
    # Initialize cooldown tracking for this session
    if session_id not in violation_cooldowns:
        violation_cooldowns[session_id] = {}
    
    try:
        # Throttle: only process a frame every 2 seconds per connection
        last_processed_time = 0.0
        FRAME_INTERVAL_SEC = 2.0
        while True:
            # Receive frame data from client
            data = await websocket.receive_text()
            message = json.loads(data)
            logger.info(f"📥 Received message type: {message.get('type')}")
            
            if message['type'] == 'frame':
                student_name = message.get('student_name', 'Unknown')
                student_id = message.get('student_id', 'Unknown')
                logger.info(f"🎥 Processing frame from student: name='{student_name}', id='{student_id}'")
                # Throttle processing to every 2 seconds
                now_ts = asyncio.get_event_loop().time()
                if (now_ts - last_processed_time) >= FRAME_INTERVAL_SEC:
                    last_processed_time = now_ts
                    # Process frame
                    try:
                        frame_data = base64.b64decode(message['frame'].split(',')[1] if ',' in message['frame'] else message['frame'])
                        logger.info(f"📦 Frame data decoded: {len(frame_data)} bytes")
                        nparr = np.frombuffer(frame_data, np.uint8)
                        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                        logger.info(f"🖼️  Frame decode result: {frame is not None}")
                    except Exception as decode_err:
                        logger.error(f"❌ Frame decode error: {decode_err}")
                        frame = None
                    
                    if frame is not None:
                        calibrated_pitch = float(message.get('calibrated_pitch', 0.0))
                        calibrated_yaw = float(message.get('calibrated_yaw', 0.0))
                        logger.info(f"🔍 Frame decoded successfully: {frame.shape}, Calibration: pitch={calibrated_pitch:.2f}°, yaw={calibrated_yaw:.2f}°")
                        
                        result = proctoring_service.process_frame(
                            frame,
                            session_id,
                            calibrated_pitch,
                            calibrated_yaw
                        )
                        violations_count = len(result.get('violations', []))
                        logger.info(f"🎯 Detection result: {violations_count} violations found")
                        logger.info(f"📊 Detection details: faces={result.get('face_count', 0)}, no_person={result.get('no_person', False)}, multiple={result.get('multiple_faces', False)}, looking_away={result.get('looking_away', False)}, phone={result.get('phone_detected', False)}, book={result.get('book_detected', False)}")
                        
                        # Log head pose info if available
                        if result.get('head_pose'):
                            hp = result['head_pose']
                            logger.info(f"📐 Head pose: pitch={hp.get('pitch', 0):.1f}°, yaw={hp.get('yaw', 0):.1f}°, roll={hp.get('roll', 0):.1f}°")
                        
                        # Log each violation type found
                        if violations_count > 0:
                            for v in result.get('violations', []):
                                logger.info(f"🚨 Violation detected: type={v.get('type')}, severity={v.get('severity')}, message={v.get('message', '')[:50]}")
                        else:
                            logger.info(f"✅ No violations detected in this frame")
                        # Persist violations with snapshot evidence
                        try:
                            exam_id = message.get('exam_id')
                            student_id = message.get('student_id')
                            student_name = message.get('student_name')
                            subject_code = message.get('subject_code', '')
                            subject_name = message.get('subject_name', '')
                            logger.info(f"📋 Extracted from message: exam_id={exam_id}, student_id={student_id}, student_name='{student_name}', subject='{subject_name}' ({subject_code})")
                            snapshot_b64 = result.get('snapshot_base64')
                            # Track which violations were actually saved (not skipped due to cooldown)
                            saved_violations = []
                            # If there are violations, upload snapshot and insert rows
                            if result.get('violations'):
                                logger.info(f"💾 Saving {len(result['violations'])} violations to database with student_name='{student_name}'...")
                                image_url = None
                                # Upload once and reuse URL for all violations in this frame
                                if snapshot_b64:
                                    logger.info(f"📸 Uploading snapshot for violation...")
                                    image_url = _upload_snapshot_and_get_url(
                                        supabase, exam_id or "unknown_exam", student_id or "unknown_student",
                                        result['violations'][0]['type'], snapshot_b64
                                    )
                                    logger.info(f"✅ Snapshot uploaded: {image_url}")
                                else:
                                    logger.warning("⚠️ No snapshot available for violation")
                                # Insert one record per violation type (with cooldown check)
                                now_ts = asyncio.get_event_loop().time()
                                for v in result['violations']:
                                    violation_type = v.get("type")
                                    
                                    # Use different cooldown for looking_away (needs longer cooldown since it requires 6s duration)
                                    cooldown_sec = LOOKING_AWAY_COOLDOWN_SEC if violation_type == 'looking_away' else VIOLATION_COOLDOWN_SEC
                                    
                                    # Check cooldown: skip if same violation type was logged recently
                                    last_violation_time = violation_cooldowns[session_id].get(violation_type, 0)
                                    if (now_ts - last_violation_time) < cooldown_sec:
                                        logger.info(f"⏸️  Violation {violation_type} skipped (cooldown: {cooldown_sec}s, elapsed: {now_ts - last_violation_time:.1f}s)")
                                        continue
                                    
                                    # Update cooldown timestamp
                                    violation_cooldowns[session_id][violation_type] = now_ts
                                    logger.info(f"✅ Violation {violation_type} passed cooldown check - will save to database")
                                    
                                    # Ensure exam_id and student_id are valid UUIDs or None (not empty strings)
                                    exam_id_str = str(exam_id).strip() if exam_id else ''
                                    student_id_str = str(student_id).strip() if student_id else ''
                                    
                                    valid_exam_id = validate_uuid(exam_id_str) if exam_id_str else None
                                    valid_student_id = validate_uuid(student_id_str) if student_id_str else None
                                    
                                    violation_record = {
                                        "id": str(uuid.uuid4()),
                                        "exam_id": valid_exam_id,
                                        "student_id": valid_student_id,
                                        "violation_type": violation_type,
                                        "severity": v.get("severity"),
                                        "details": {
                                            "message": v.get("message"),
                                            "confidence": v.get("confidence"),
                                            "session_id": session_id,
                                            "student_name": student_name,
                                            "student_id": student_id,
                                            "subject_code": subject_code,
                                            "subject_name": subject_name,
                                        },
                                        "image_url": image_url,
                                        "timestamp": datetime.utcnow().isoformat()
                                    }
                                    try:
                                        supabase.table('violations').insert(violation_record).execute()
                                        logger.info(f"✅ Violation saved: {violation_type} - {v.get('message')}")
                                        # Only add to saved_violations if successfully saved
                                        saved_violations.append(v)
                                    except Exception as db_err:
                                        logger.error(f"❌ Insert violation failed: {db_err}")
                            else:
                                logger.info("✅ No violations detected in this frame")
                        except Exception as persist_err:
                            logger.error(f"❌ Persisting violation failed: {persist_err}")
                        
                        # Send results back to client - ONLY include violations that were actually saved
                        # This prevents duplicate counting in the frontend
                        result_to_send = result.copy()
                        result_to_send['violations'] = saved_violations
                        await websocket.send_json({
                            'type': 'detection_result',
                            'data': result_to_send
                        })
                        logger.info(f"📤 Detection result sent to client")
                        
                        # Also send individual violation alerts to frontend (only for saved violations)
                        if saved_violations:
                            for v in saved_violations:
                                await websocket.send_json({
                                    'type': 'violation',
                                    'data': {
                                        'type': v.get('type'),
                                        'severity': v.get('severity'),
                                        'message': v.get('message'),
                                        'confidence': v.get('confidence'),
                                        'timestamp': datetime.utcnow().isoformat()
                                    }
                                })
                                logger.info(f"🚨 Violation alert sent to frontend: {v.get('type')}")
                    else:
                        logger.error("❌ Frame is None - could not decode image data")
                        await websocket.send_json({
                            'type': 'error',
                            'data': {'message': 'Failed to decode frame image'}
                        })
                else:
                    # Optionally inform client that frame was skipped due to throttle
                    await websocket.send_json({
                        'type': 'detection_skipped',
                        'data': {
                            'reason': 'throttled',
                            'interval_sec': FRAME_INTERVAL_SEC,
                            'timestamp': datetime.utcnow().isoformat()
                        }
                    })
                    
            elif message['type'] == 'audio':
                # Process audio level
                audio_level = float(message.get('audio_level', 0))
                student_name = message.get('student_name')
                exam_id = message.get('exam_id')
                student_id = message.get('student_id')
                
                logger.info(f"🎤 Audio message - level: {audio_level}%, student: '{student_name}', exam_id: {exam_id}, student_id: {student_id}")
                
                if not student_name or student_name.strip() == '':
                    logger.warning(f"⚠️ No student_name in audio message! Keys: {list(message.keys())}")
                    student_name = 'Unknown Student'
                # Always echo current audio level so UI can update in real-time
                await websocket.send_json({
                    'type': 'audio_level',
                    'data': {
                        'level': audio_level,
                        'timestamp': datetime.utcnow().isoformat()
                    }
                })
                logger.info(f"📤 Audio level echoed: {audio_level}% for student: {student_name}")
                # Record a violation if audio exceeds threshold
                try:
                    AUDIO_THRESHOLD = 30  # Threshold for excessive noise detection
                    logger.info(f"🔍 Checking audio violation: level={audio_level}%, threshold={AUDIO_THRESHOLD}%, exceeds={audio_level >= AUDIO_THRESHOLD}")
                    # Trigger violation if audio level exceeds threshold
                    if audio_level >= AUDIO_THRESHOLD:
                        logger.info(f"🔊 Audio level {audio_level}% exceeds threshold {AUDIO_THRESHOLD}% - processing violation...")
                        # Check cooldown for audio violations (reduced cooldown for audio to catch sustained noise)
                        now_ts = asyncio.get_event_loop().time()
                        last_audio_violation = violation_cooldowns[session_id].get('excessive_noise', 0)
                        AUDIO_COOLDOWN_SEC = 5.0  # Cooldown to prevent spam (5 seconds between audio violations)
                        if (now_ts - last_audio_violation) < AUDIO_COOLDOWN_SEC:
                            logger.info(f"⏸️  Audio violation skipped (cooldown: {AUDIO_COOLDOWN_SEC}s, last: {last_audio_violation:.1f}s, now: {now_ts:.1f}s, elapsed: {now_ts - last_audio_violation:.1f}s, level: {audio_level}%)")
                        else:
                            # Update cooldown
                            violation_cooldowns[session_id]['excessive_noise'] = now_ts
                            
                            exam_id = message.get('exam_id')
                            student_id = message.get('student_id')
                            # CRITICAL: Always get student_name from message - this is the source of truth
                            student_name = message.get('student_name')
                            subject_code = message.get('subject_code', '')
                            subject_name = message.get('subject_name', '')
                            
                            # Log received values for debugging
                            logger.info(f"🔍 Audio violation - exam_id: {exam_id} (type: {type(exam_id).__name__}), student_id: {student_id} (type: {type(student_id).__name__}), student_name: '{student_name}'")
                            
                            # Always use student_name from message - this is the source of truth from frontend
                            if not student_name or student_name.strip() == '':
                                logger.warning(f"⚠️ No student_name in audio message - using 'Unknown Student'")
                                student_name = 'Unknown Student'
                            else:
                                logger.info(f"✅ Using student_name from message: '{student_name}'")
                            
                            # Determine severity based on audio level
                            if audio_level >= 60:
                                severity = "high"
                                severity_msg = "Very loud background noise"
                            elif audio_level >= 45:
                                severity = "medium"
                                severity_msg = "Loud background noise"
                            else:
                                severity = "low"
                                severity_msg = "Moderate background noise"
                            
                            logger.info(f"🔊 Audio violation detected: level={audio_level}%, threshold={AUDIO_THRESHOLD}%, severity={severity}")
                            
                            # Ensure exam_id and student_id are valid UUIDs or None (not empty strings)
                            # Handle empty strings, None, or invalid values - but be more lenient
                            exam_id_str = str(exam_id).strip() if exam_id else ''
                            student_id_str = str(student_id).strip() if student_id else ''
                            
                            # Validate UUIDs - but allow saving even if invalid (database may allow NULL)
                            valid_exam_id = validate_uuid(exam_id_str) if exam_id_str else None
                            valid_student_id = validate_uuid(student_id_str) if student_id_str else None
                            
                            # Log validation results
                            if not valid_exam_id and exam_id_str:
                                logger.warning(f"⚠️ Invalid exam_id format: '{exam_id_str}' - will save with NULL exam_id")
                            if not valid_student_id and student_id_str:
                                logger.warning(f"⚠️ Invalid student_id format: '{student_id_str}' - will save with NULL student_id")
                            
                            logger.info(f"🔍 Validated IDs - exam_id: {valid_exam_id}, student_id: {valid_student_id} (original: exam_id={exam_id}, student_id={student_id})")
                            
                            # IMPORTANT: Save violation even if UUIDs are invalid (database allows NULL)
                            # This ensures audio violations are always recorded
                            
                            violation_record = {
                                "id": str(uuid.uuid4()),
                                "exam_id": valid_exam_id,
                                "student_id": valid_student_id,
                                "violation_type": "excessive_noise",
                                "severity": severity,
                                "student_name": student_name,
                                "details": {
                                    "message": f"{severity_msg} detected - Audio level: {audio_level:.0f}% (Threshold: {AUDIO_THRESHOLD}%)",
                                    "audio_level": audio_level,
                                    "threshold": AUDIO_THRESHOLD,
                                    "session_id": session_id,
                                    "student_name": student_name,
                                    "student_id": student_id,
                                    "subject_code": subject_code,
                                    "subject_name": subject_name,
                                },
                                "image_url": None,
                                "timestamp": datetime.utcnow().isoformat()
                            }
                            
                            logger.info(f"💾 Saving audio violation - student_name: '{student_name}', exam_id: {valid_exam_id}, student_id: {valid_student_id}")
                            logger.info(f"   Violation record student_name field: '{violation_record.get('student_name')}'")
                            logger.info(f"   Violation record details.student_name: '{violation_record.get('details', {}).get('student_name')}'")
                            # Prepare violation alert message (send even if DB save fails)
                            violation_alert = {
                                'type': 'excessive_noise',  # Match the violation_type saved to database
                                'violation_type': 'excessive_noise',  # Also include for compatibility
                                'severity': severity,
                                'message': f'{severity_msg} detected - Audio level: {audio_level:.0f}% (Threshold: {AUDIO_THRESHOLD}%)',
                                'audio_level': float(audio_level),
                                'threshold': float(AUDIO_THRESHOLD),
                                'timestamp': datetime.utcnow().isoformat()
                            }
                            
                            # Try to save to database
                            # IMPORTANT: Save even if UUIDs are None - database should allow NULL values
                            try:
                                logger.info(f"💾 Attempting to save audio violation: violation_type={violation_record['violation_type']}, exam_id={valid_exam_id}, student_id={valid_student_id}")
                                logger.info(f"   Full violation record keys: {list(violation_record.keys())}")
                                
                                # Insert violation - database should accept NULL for exam_id and student_id
                                result = supabase.table('violations').insert(violation_record).execute()
                                
                                if result.data and len(result.data) > 0:
                                    saved_violation = result.data[0]
                                    logger.info(f"✅ Audio violation saved - ID: {saved_violation.get('id')}, student_name: '{saved_violation.get('student_name')}', details.student_name: '{saved_violation.get('details', {}).get('student_name')}'")
                                else:
                                    logger.warning(f"⚠️ No data returned from insert, but no error raised")
                                    logger.warning(f"   Result object: {result}")
                                    
                            except Exception as db_error:
                                error_msg = str(db_error)
                                logger.error(f"❌ Failed to save audio violation: {error_msg}")
                                logger.error(f"   Error type: {type(db_error).__name__}")
                                
                                # Check if error is due to UUID constraint
                                if 'uuid' in error_msg.lower() or 'invalid' in error_msg.lower() or 'constraint' in error_msg.lower():
                                    logger.error(f"   ⚠️ Possible UUID constraint violation - trying to save with NULL values")
                                    # Try saving with explicit NULL instead of invalid UUID
                                    try:
                                        violation_record_null = violation_record.copy()
                                        violation_record_null['exam_id'] = None
                                        violation_record_null['student_id'] = None
                                        result_retry = supabase.table('violations').insert(violation_record_null).execute()
                                        if result_retry.data:
                                            logger.info(f"✅ Audio violation saved with NULL IDs (retry successful)")
                                        else:
                                            logger.error(f"❌ Retry also failed - no data returned")
                                    except Exception as retry_error:
                                        logger.error(f"❌ Retry with NULL IDs also failed: {retry_error}")
                                
                                logger.error(f"   Violation record: {json.dumps(violation_record, indent=2, default=str)}")
                                import traceback
                                logger.error(f"   Traceback: {traceback.format_exc()}")
                                # Continue anyway - still send alert to frontend
                            
                            # Always send violation alert to frontend for immediate UI update (even if DB save failed)
                            try:
                                await websocket.send_json({
                                    'type': 'violation',
                                    'data': violation_alert
                                })
                                logger.info(f"📤 Audio violation alert sent - type: {violation_alert['type']}, student: {student_name}")
                                logger.info(f"   Alert data: {violation_alert}")
                            except Exception as ws_error:
                                logger.error(f"❌ Failed to send audio violation alert to frontend: {ws_error}")
                except Exception as e:
                    logger.error(f"❌ Audio violation insert failed: {e}")
                    
            elif message['type'] == 'browser_activity':
                # Handle browser activity violations (tab switch, copy/paste)
                try:
                    exam_id = message.get('exam_id')
                    student_id = message.get('student_id')
                    student_name = message.get('student_name')
                    subject_code = message.get('subject_code', '')
                    subject_name = message.get('subject_name', '')
                    violation_type = message.get('violation_type')
                    violation_message = message.get('message')
                    
                    # Check cooldown for browser activity violations
                    now_ts = asyncio.get_event_loop().time()
                    last_browser_violation = violation_cooldowns[session_id].get(violation_type, 0)
                    if (now_ts - last_browser_violation) < VIOLATION_COOLDOWN_SEC:
                        logger.info(f"⏸️  Browser activity violation {violation_type} skipped (cooldown: {VIOLATION_COOLDOWN_SEC}s)")
                    else:
                        # Update cooldown
                        violation_cooldowns[session_id][violation_type] = now_ts
                        
                        # Save browser activity violation to database (NO snapshot for browser activity)
                        # Ensure exam_id and student_id are valid UUIDs or None (not empty strings)
                        exam_id_str = str(exam_id).strip() if exam_id else ''
                        student_id_str = str(student_id).strip() if student_id else ''
                        
                        valid_exam_id = validate_uuid(exam_id_str) if exam_id_str else None
                        valid_student_id = validate_uuid(student_id_str) if student_id_str else None
                        
                        violation_record = {
                            "id": str(uuid.uuid4()),
                            "exam_id": valid_exam_id,
                            "student_id": valid_student_id,
                            "violation_type": violation_type,
                            "severity": "medium",
                            "details": {
                                "message": violation_message,
                                "session_id": session_id,
                                "student_name": student_name,
                                "student_id": student_id or "N/A",
                                "subject_code": subject_code or "N/A",
                                "subject_name": subject_name or "N/A",
                            },
                            "image_url": None,  # No snapshot for browser activity
                            "timestamp": datetime.utcnow().isoformat()
                        }
                        supabase.table('violations').insert(violation_record).execute()
                        
                        # Send violation alert back to client for real-time UI update
                        await websocket.send_json({
                            'type': 'violation',
                            'data': {
                                'type': violation_type,
                                'severity': 'medium',
                                'message': violation_message,
                                'timestamp': datetime.utcnow().isoformat()
                            }
                        })
                        logger.info(f"Browser activity violation recorded: {violation_type} for student {student_name} (ID: {student_id})")
                except Exception as e:
                    logger.error(f"Browser activity violation insert failed: {e}")
                    
            elif message['type'] == 'ping':
                await websocket.send_json({'type': 'pong'})
                
    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected: {session_id}")
        if session_id in active_connections:
            del active_connections[session_id]
        # Clean up cooldown tracking
        if session_id in violation_cooldowns:
            del violation_cooldowns[session_id]
    except Exception as e:
        logger.error(f"WebSocket error for {session_id}: {e}")
        if session_id in active_connections:
            del active_connections[session_id]

@app.post("/api/upload-violation-snapshot")
async def upload_violation_snapshot(
    exam_id: str,
    student_id: str,
    student_name: str,
    violation_type: str,
    snapshot_base64: str
):
    """Upload violation snapshot to Supabase Storage"""
    try:
        # Decode base64 image
        image_data = base64.b64decode(snapshot_base64.split(',')[1] if ',' in snapshot_base64 else snapshot_base64)
        
        # Generate filename
        timestamp = datetime.utcnow().strftime('%Y%m%d_%H%M%S')
        filename = f"{exam_id}/{student_id}_{violation_type}_{timestamp}.jpg"
        
        # Upload to Supabase Storage
        response = supabase.storage.from_('violation-evidence').upload(
            filename,
            image_data,
            file_options={"content-type": "image/jpeg"}
        )
        
        # Get public URL
        public_url = supabase.storage.from_('violation-evidence').get_public_url(filename)
        
        return {
            "success": True,
            "url": public_url,
            "filename": filename
        }
    except Exception as e:
        logger.error(f"Upload error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/violations")
async def create_violation(violation_data: dict):
    """Create a violation record in Supabase"""
    try:
        # Insert violation into Supabase
        violation_record = {
            "id": str(uuid.uuid4()),
            "exam_id": violation_data.get("exam_id") or "unknown",
            "student_id": violation_data.get("student_id") or "unknown",
            "violation_type": violation_data.get("violation_type") or "unknown",
            "severity": violation_data.get("severity", "medium"),
            "details": violation_data.get("details", {}),
            "image_url": violation_data.get("image_url"),
            "timestamp": datetime.utcnow().isoformat()
        }
        
        result = supabase.table('violations').insert(violation_record).execute()
        
        return {
            "success": True,
            "violation_id": violation_record["id"],
            "message": "Violation recorded successfully"
        }
    except Exception as e:
        logger.error(f"Error creating violation: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/violations")
async def get_violations(exam_id: str = None, student_id: str = None):
    """Get violations from Supabase"""
    try:
        query = supabase.table('violations').select('*')
        
        if exam_id:
            query = query.eq('exam_id', exam_id)
        if student_id:
            query = query.eq('student_id', student_id)
            
        result = query.order('timestamp', desc=True).execute()
        
        return {
            "success": True,
            "violations": result.data
        }
    except Exception as e:
        logger.error(f"Error fetching violations: {e}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
