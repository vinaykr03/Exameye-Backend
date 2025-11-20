import cv2
import mediapipe as mp
import numpy as np
from ultralytics import YOLO
import base64
from typing import Dict, Optional, Tuple
import time
from datetime import datetime
import logging

logger = logging.getLogger(__name__)

class ProctoringService:
    """
    AI-powered proctoring service using MediaPipe and YOLOv8n
    Detects: looking away, multiple people, prohibited objects (phone, book)
    """
    
    def __init__(self):

        # Initialize MediaPipe
        self.mp_face_mesh = mp.solutions.face_mesh.FaceMesh(
            refine_landmarks=True,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5
        )
        self.mp_face_detection = mp.solutions.face_detection.FaceDetection(
            min_detection_confidence=0.5
        )
        
        # Initialize YOLO model with optimized settings
        self.yolo_model = YOLO('models/yolov8n.pt')
        self.yolo_model.conf = 0.35  # Confidence threshold (reduced for better detection)
        
        # 3D Model points for head pose estimation
        self.model_points = np.array([
            (0.0, 0.0, 0.0),
            (0.0, -330.0, -65.0),
            (-225.0, 170.0, -135.0),
            (225.0, 170.0, -135.0),
            (-150.0, -150.0, -125.0),
            (150.0, -150.0, -125.0)
        ], dtype=np.float64)
        
        # Thresholds for head pose detection (in degrees)
        # These values detect when user looks away from screen
        # Triggers when head is turned more than 70 degrees in any direction
        # Note: Using lower threshold (30°) for more reliable detection, but can be adjusted
        self.MIN_YAW_OFFSET = 20  # Minimum threshold - ignore minor turns below this
        self.MAX_YAW_OFFSET = 30  # Maximum threshold - detect significant turns above this (catches 30°+ turns)
        self.MIN_PITCH_OFFSET = 20  # Minimum threshold - ignore minor up/down movements below this
        self.MAX_PITCH_OFFSET = 30  # Maximum threshold - detect significant up/down movements above this (catches 30°+ turns)
        
        # Additional validation to reduce false positives
        self.MIN_FACE_CONFIDENCE = 0.5  # Minimum confidence for face detection
        self.REQUIRE_STABLE_POSE = True  # Require pose to be stable before detecting
        
        # Detection confidence thresholds
        self.OBJECT_CONFIDENCE_THRESHOLD = 0.35  # Reduced for better object detection
        self.FACE_CONFIDENCE_THRESHOLD = 0.4   # Reduced for better face detection
        
        # Snapshot throttle per session: only allow snapshot every 2 seconds
        self.SNAPSHOT_INTERVAL_SEC = 2.0
        self.last_snapshot_time_by_session: Dict[str, float] = {}
        
        # Head pose tracking for sustained looking away
        self.head_pose_tracking: Dict[str, Dict] = {}
        self.HEAD_AWAY_DURATION_THRESHOLD_SEC = 0.5  # 0.5 seconds - faster detection while reducing false positives
        # This ensures we detect looking away quickly while filtering out momentary glances
        
    def estimate_head_pose(self, landmarks, width: int, height: int) -> Optional[Tuple[float, float, float]]:
        """
        Estimate head pose (pitch, yaw, roll) from facial landmarks
        """
        try:
            image_points = np.array([
                (landmarks[1].x * width, landmarks[1].y * height),
                (landmarks[152].x * width, landmarks[152].y * height),
                (landmarks[33].x * width, landmarks[33].y * height),
                (landmarks[263].x * width, landmarks[263].y * height),
                (landmarks[61].x * width, landmarks[61].y * height),
                (landmarks[291].x * width, landmarks[291].y * height)
            ], dtype=np.float64)
            
            focal_length = width
            camera_matrix = np.array([
                [focal_length, 0, width / 2],
                [0, focal_length, height / 2],
                [0, 0, 1]
            ], dtype=np.float64)
            
            success, rotation_vector, _ = cv2.solvePnP(
                self.model_points, 
                image_points, 
                camera_matrix, 
                np.zeros((4, 1))
            )
            
            if not success:
                return None
                
            # Convert rotation vector to Euler angles
            rmat, _ = cv2.Rodrigues(rotation_vector)
            
            # Extract Euler angles from rotation matrix (more stable method)
            sy = np.sqrt(rmat[0,0] * rmat[0,0] + rmat[1,0] * rmat[1,0])
            singular = sy < 1e-6
            
            if not singular:
                pitch = np.arctan2(-rmat[2,0], sy) * 180 / np.pi
                yaw = np.arctan2(rmat[1,0], rmat[0,0]) * 180 / np.pi
                roll = np.arctan2(rmat[2,1], rmat[2,2]) * 180 / np.pi
            else:
                pitch = np.arctan2(-rmat[2,0], sy) * 180 / np.pi
                yaw = np.arctan2(-rmat[1,2], rmat[1,1]) * 180 / np.pi
                roll = 0
            
            # Validate angles are within reasonable range (allow up to 180° for extreme turns)
            # Note: MediaPipe can sometimes give angles outside -90 to 90, which is valid for extreme head turns
            if abs(pitch) > 180 or abs(yaw) > 180:
                logger.warning(f"⚠️ Extreme head pose angles (yaw={yaw:.1f}°, pitch={pitch:.1f}°) - may be invalid, skipping")
                return None
                
            return (pitch, yaw, roll)
            
        except Exception as e:
            logger.error(f"Head pose estimation error: {e}")
            return None

    def is_looking_away(self, pitch: float, yaw: float, calibrated_pitch: float, calibrated_yaw: float) -> bool:
        """
        Check if user is looking away from camera based on calibrated values
        Detects significant head turns in any direction: left, right, up, or down
        
        Args:
            pitch: Current head pitch angle (up/down)
            yaw: Current head yaw angle (left/right)
            calibrated_pitch: Calibrated pitch (baseline)
            calibrated_yaw: Calibrated yaw (baseline)
        
        Returns:
            True if head is turned away significantly, False otherwise
        """
        # Always log current angles for debugging
        logger.info(f"📐 Current angles: yaw={yaw:.1f}°, pitch={pitch:.1f}°, calibrated_yaw={calibrated_yaw:.1f}°, calibrated_pitch={calibrated_pitch:.1f}°")
        
        # Handle no calibration case - use absolute values with threshold
        if calibrated_yaw == 0.0 and calibrated_pitch == 0.0:
            abs_yaw = abs(yaw)
            abs_pitch = abs(pitch)
            # Check both yaw (left/right) and pitch (up/down)
            is_away_yaw = abs_yaw >= self.MAX_YAW_OFFSET
            is_away_pitch = abs_pitch >= self.MAX_PITCH_OFFSET
            logger.info(f"🔍 No calibration: abs_yaw={abs_yaw:.1f}° (threshold: {self.MAX_YAW_OFFSET}°), abs_pitch={abs_pitch:.1f}° (threshold: {self.MAX_PITCH_OFFSET}°)")
            return is_away_yaw or is_away_pitch
        
        # Normal case: calibration is set, use offset from calibrated position
        yaw_offset = abs(yaw - calibrated_yaw)
        pitch_offset = abs(pitch - calibrated_pitch)
        
        # Also check absolute angles as fallback (in case calibration is off)
        abs_yaw = abs(yaw)
        abs_pitch = abs(pitch)
        
        # Detect significant turns in either direction
        # Check both offset from calibration AND absolute angle
        is_away_yaw_offset = yaw_offset >= self.MAX_YAW_OFFSET
        is_away_pitch_offset = pitch_offset >= self.MAX_PITCH_OFFSET
        is_away_yaw_absolute = abs_yaw >= self.MAX_YAW_OFFSET
        is_away_pitch_absolute = abs_pitch >= self.MAX_PITCH_OFFSET
        
        # Use either offset-based or absolute-based detection (whichever triggers)
        is_away_yaw = is_away_yaw_offset or is_away_yaw_absolute
        is_away_pitch = is_away_pitch_offset or is_away_pitch_absolute
        
        is_away = is_away_yaw or is_away_pitch
        
        # Log for debugging
        logger.info(f"🔍 Detection: yaw_offset={yaw_offset:.1f}°, pitch_offset={pitch_offset:.1f}°, abs_yaw={abs_yaw:.1f}°, abs_pitch={abs_pitch:.1f}°")
        if is_away:
            if is_away_yaw:
                logger.info(f"👀 Looking away detected (yaw): offset={yaw_offset:.1f}°, absolute={abs_yaw:.1f}° (threshold: {self.MAX_YAW_OFFSET}°)")
            if is_away_pitch:
                logger.info(f"👀 Looking away detected (pitch): offset={pitch_offset:.1f}°, absolute={abs_pitch:.1f}° (threshold: {self.MAX_PITCH_OFFSET}°)")
        else:
            logger.info(f"✅ Not looking away: yaw_offset={yaw_offset:.1f}° < {self.MAX_YAW_OFFSET}°, pitch_offset={pitch_offset:.1f}° < {self.MAX_PITCH_OFFSET}°")
        
        return is_away
    
    def track_head_pose(self, session_id: str, is_looking_away: bool, direction: str, current_time: float) -> Optional[Dict]:
        """
        Track head pose over time. Returns violation only after sustained looking away.
        Requires 0.5 seconds of continuous looking away to detect quickly while reducing false positives.
        This ensures we detect looking away promptly while filtering out momentary glances.
        """
        if is_looking_away and direction:
            if session_id not in self.head_pose_tracking:
                # Start tracking when user starts looking away
                self.head_pose_tracking[session_id] = {
                    'start_time': current_time,
                    'direction': direction,
                    'violation_reported': False,  # Flag to ensure violation is reported only once per event
                    'consecutive_frames': 1  # Track consecutive frames looking away
                }
                logger.info(f"👀 Started tracking looking away: direction={direction}")
                return None

            tracking_data = self.head_pose_tracking[session_id]
            
            # If direction changes, reset start time and reported flag
            if tracking_data['direction'] != direction:
                logger.info(f"🔄 Direction changed: {tracking_data['direction']} -> {direction}, resetting tracking")
                tracking_data['start_time'] = current_time
                tracking_data['direction'] = direction
                tracking_data['violation_reported'] = False  # Reset flag on direction change
                tracking_data['consecutive_frames'] = 1
            else:
                # Same direction - increment consecutive frames
                tracking_data['consecutive_frames'] = tracking_data.get('consecutive_frames', 1) + 1

            duration = current_time - tracking_data['start_time']

            # Require minimum duration AND consecutive frames to reduce false positives
            # This ensures the head turn is sustained, not just a momentary glance
            min_consecutive_frames = 1  # Require at least 1 consecutive frame (reduced for faster detection)
            
            if (duration >= self.HEAD_AWAY_DURATION_THRESHOLD_SEC and 
                tracking_data.get('consecutive_frames', 0) >= min_consecutive_frames and
                not tracking_data.get('violation_reported')):
                
                tracking_data['violation_reported'] = True  # Mark as reported
                logger.info(f"🚨 Looking away violation triggered: direction={direction}, duration={duration:.1f}s, frames={tracking_data.get('consecutive_frames', 0)}")
                return {
                    'type': 'looking_away',
                    'severity': 'high',
                    'message': f'Head turned {direction} away from screen for {duration:.1f} seconds.',
                    'duration': duration,
                    'direction': direction
                }
        else:
            # User is not looking away, so reset tracking
            if session_id in self.head_pose_tracking:
                logger.info(f"✅ Head returned to normal position - resetting tracking")
                del self.head_pose_tracking[session_id]
        
        return None

    def detect_multiple_faces(self, detections) -> bool:
        """
        Check if multiple faces are detected
        """
        return len(detections) > 1 if detections else False

    def detect_prohibited_objects(self, frame: np.ndarray) -> Dict[str, any]:
        """
        Detect prohibited objects (cell phone, book) using YOLOv8
        Returns dict with detection info and annotated frame
        """
        detections = {
            'phone_detected': False,
            'book_detected': False,
            'objects': []
        }
        
        try:
            # Run YOLO detection with confidence threshold
            yolo_results = self.yolo_model(
                frame, 
                stream=True, 
                verbose=False,
                conf=self.OBJECT_CONFIDENCE_THRESHOLD
            )
            
            for result in yolo_results:
                if result.boxes is None or len(result.boxes) == 0:
                    continue
                    
                for box in result.boxes:
                    cls = result.names[int(box.cls[0])]
                    confidence = float(box.conf[0])
                    
                    # Only process if confidence meets threshold
                    if confidence < self.OBJECT_CONFIDENCE_THRESHOLD:
                        continue
                    
                    x1, y1, x2, y2 = map(int, box.xyxy[0])
                    
                    # Detect cell phone (including variations)
                    if cls in ["cell phone", "phone", "mobile"]:
                        detections['objects'].append({
                            'type': 'cell phone',
                            'confidence': confidence,
                            'bbox': [x1, y1, x2, y2]
                        })
                        detections['phone_detected'] = True
                        
                        # Draw bounding box
                        cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 0, 255), 3)
                        cv2.putText(frame, f"PHONE {confidence:.2f}", (x1, y1 - 10),
                                  cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
                    
                    # Detect book
                    elif cls == "book":
                        detections['objects'].append({
                            'type': 'book',
                            'confidence': confidence,
                            'bbox': [x1, y1, x2, y2]
                        })
                        detections['book_detected'] = True
                        
                        # Draw bounding box
                        cv2.rectangle(frame, (x1, y1), (x2, y2), (255, 0, 0), 3)
                        cv2.putText(frame, f"BOOK {confidence:.2f}", (x1, y1 - 10),
                                  cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 0, 0), 2)
        except Exception as e:
            print(f"Object detection error: {e}")
        
        detections['annotated_frame'] = frame
        return detections

    def calibrate_head_pose(self, frame: np.ndarray) -> Dict:
        """
        Calibrate head pose from a frame
        Returns calibration values
        """
        try:
            height, width, _ = frame.shape
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            
            face_mesh_results = self.mp_face_mesh.process(rgb_frame)
            if face_mesh_results.multi_face_landmarks:
                landmarks = face_mesh_results.multi_face_landmarks[0].landmark
                angles = self.estimate_head_pose(landmarks, width, height)
                
                if angles:
                    pitch, yaw, roll = angles
                    return {
                        'success': True,
                        'pitch': float(pitch),
                        'yaw': float(yaw),
                        'roll': float(roll)
                    }
            
            return {'success': False, 'message': 'No face detected for calibration'}
        except Exception as e:
            return {'success': False, 'message': f'Calibration error: {str(e)}'}
    
    def check_environment(self, frame: np.ndarray) -> Dict:
        """
        Check environment lighting and face detection
        """
        try:
            height, width, _ = frame.shape
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            
            # Check lighting (convert to grayscale and check brightness)
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            brightness = np.mean(gray)
            lighting_ok = 40 < brightness < 220  # Acceptable range
            
            # Check face detection
            face_detection_results = self.mp_face_detection.process(rgb_frame)
            face_detected = face_detection_results.detections is not None and len(face_detection_results.detections) > 0
            
            # Check if face is centered
            face_centered = False
            if face_detected:
                detection = face_detection_results.detections[0]
                bbox = detection.location_data.relative_bounding_box
                center_x = bbox.xmin + bbox.width / 2
                center_y = bbox.ymin + bbox.height / 2
                face_centered = (0.3 < center_x < 0.7) and (0.2 < center_y < 0.7)
            
            message = []
            if not lighting_ok:
                if brightness < 40:
                    message.append("Lighting too dark")
                else:
                    message.append("Lighting too bright")
            if not face_detected:
                message.append("No face detected")
            elif not face_centered:
                message.append("Face not centered")
            
            if not message:
                message.append("Environment check passed")
            
            return {
                'lighting_ok': lighting_ok,
                'face_detected': face_detected,
                'face_centered': face_centered,
                'message': ', '.join(message),
                'brightness': float(brightness)
            }
        except Exception as e:
            return {
                'lighting_ok': False,
                'face_detected': False,
                'face_centered': False,
                'message': f'Environment check error: {str(e)}'
            }

    def process_frame(self, frame: np.ndarray, session_id: str, calibrated_pitch: float, calibrated_yaw: float) -> Dict:
        """
        Process a single frame for all violations
        Returns comprehensive violation report
        """
        try:
            if frame is None:
                return {'error': 'Invalid frame data'}
            
            # Log calibration values for debugging (only if not 0.0)
            if calibrated_pitch != 0.0 or calibrated_yaw != 0.0:
                logger.info(f"🎯 Processing frame for session {session_id}: calibrated_pitch={calibrated_pitch:.1f}°, calibrated_yaw={calibrated_yaw:.1f}°")
            else:
                # Only log once per session to avoid spam
                if not hasattr(self, '_logged_no_calibration'):
                    self._logged_no_calibration = set()
                if session_id not in self._logged_no_calibration:
                    logger.warning(f"⚠️ No calibration set for session {session_id} - using default values. Head pose detection may be less accurate.")
                    self._logged_no_calibration.add(session_id)
            
            height, width, _ = frame.shape
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            
            # Initialize result
            result = {
                'timestamp': datetime.utcnow().isoformat(),
                'violations': [],
                'head_pose': None,
                'face_count': 0,
                'looking_away': False,
                'multiple_faces': False,
                'no_person': False,
                'phone_detected': False,
                'book_detected': False,
                'snapshot_base64': None
            }
            
            # Detect multiple faces first
            face_detection_results = self.mp_face_detection.process(rgb_frame)
            if face_detection_results.detections:
                result['face_count'] = len(face_detection_results.detections)
                
                if self.detect_multiple_faces(face_detection_results.detections):
                    result['multiple_faces'] = True
                    face_count = len(face_detection_results.detections)
                    result['violations'].append({
                        'type': 'multiple_person',  # Use multiple_person for consistency
                        'severity': 'high',
                        'message': f'{face_count} people detected in frame'
                    })
                    cv2.putText(frame, "MULTIPLE PEOPLE DETECTED!", (50, 100),
                              cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)
            else:
                # No person detected - but check if frame is too dark/black (webcam off)
                # Calculate frame brightness to avoid false positives when webcam is black
                gray_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                mean_brightness = np.mean(gray_frame)
                BRIGHTNESS_THRESHOLD = 15  # If frame is too dark, don't flag as violation (reduced for better detection)
                
                # Only flag as no_person if frame has reasonable brightness (webcam is on but no person)
                if mean_brightness >= BRIGHTNESS_THRESHOLD:
                    result['no_person'] = True
                    result['violations'].append({
                        'type': 'no_person',
                        'severity': 'medium',
                        'message': f'No person detected in frame (brightness: {mean_brightness:.1f})'
                    })
                    cv2.putText(frame, "NO PERSON DETECTED!", (50, 50),
                              cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)
                else:
                    # Frame is too dark - likely webcam is off/black, don't flag as violation
                    logger.info(f"⚠️  Frame too dark (brightness: {mean_brightness:.1f}), skipping no_person violation")
            
            # Process face mesh for head pose (only if single person detected)
            # IMPORTANT: Only process head pose if exactly 1 face is detected to reduce false positives
            if result['face_count'] == 1:
                logger.info(f"👤 Single face detected - processing head pose estimation")
                face_mesh_results = self.mp_face_mesh.process(rgb_frame)
                if face_mesh_results.multi_face_landmarks:
                    landmarks = face_mesh_results.multi_face_landmarks[0].landmark
                    angles = self.estimate_head_pose(landmarks, width, height)
                    
                    if angles:
                        logger.info(f"✅ Head pose estimated successfully")
                        pitch, yaw, roll = angles
                        
                        # Validate angles are reasonable (not NaN or extreme values)
                        if not (np.isfinite(pitch) and np.isfinite(yaw) and np.isfinite(roll)):
                            logger.warning(f"⚠️ Invalid head pose angles (NaN/Inf) - skipping detection")
                        elif abs(yaw) > 180 or abs(pitch) > 180:
                            logger.warning(f"⚠️ Extreme head pose angles (yaw={yaw:.1f}°, pitch={pitch:.1f}°) - may be invalid, skipping")
                        else:
                            result['head_pose'] = {
                                'pitch': float(pitch),
                                'yaw': float(yaw),
                                'roll': float(roll)
                            }
                            
                            # Warn if calibration values are 0.0 (might indicate calibration not set)
                            if calibrated_yaw == 0.0 and calibrated_pitch == 0.0:
                                logger.warning(f"⚠️ Calibration values are both 0.0 - using absolute yaw value for detection")
                            
                            # Check if looking away
                            is_looking_away = self.is_looking_away(pitch, yaw, calibrated_pitch, calibrated_yaw)
                            
                            # Log head pose for debugging (only if looking away detected)
                            if is_looking_away:
                                yaw_offset = abs(yaw - calibrated_yaw) if calibrated_yaw != 0.0 else abs(yaw)
                                pitch_offset = abs(pitch - calibrated_pitch) if calibrated_pitch != 0.0 else abs(pitch)
                                logger.info(f"🔍 Head pose check: yaw={yaw:.1f}°, pitch={pitch:.1f}°, yaw_offset={yaw_offset:.1f}°, pitch_offset={pitch_offset:.1f}°, is_looking_away={is_looking_away}")
                            
                            # Calculate direction for tracking (if looking away)
                            # Track all four directions: left, right, up, down
                            direction = None
                            if is_looking_away:
                                # Calculate offsets from calibrated position
                                if calibrated_yaw == 0.0:
                                    yaw_diff = yaw
                                else:
                                    yaw_diff = yaw - calibrated_yaw
                                
                                if calibrated_pitch == 0.0:
                                    pitch_diff = pitch
                                else:
                                    pitch_diff = pitch - calibrated_pitch
                                
                                # Determine which direction has the larger offset
                                yaw_offset = abs(yaw_diff)
                                pitch_offset = abs(pitch_diff)
                                
                                # Check which direction exceeds threshold more
                                if yaw_offset >= self.MAX_YAW_OFFSET and yaw_offset >= pitch_offset:
                                    # Left/right movement is dominant
                                    direction = 'right' if yaw_diff > 0 else 'left'
                                elif pitch_offset >= self.MAX_PITCH_OFFSET and pitch_offset >= yaw_offset:
                                    # Up/down movement is dominant
                                    direction = 'down' if pitch_diff > 0 else 'up'
                                elif yaw_offset >= self.MAX_YAW_OFFSET:
                                    # Yaw exceeds threshold (even if pitch is also high)
                                    direction = 'right' if yaw_diff > 0 else 'left'
                                elif pitch_offset >= self.MAX_PITCH_OFFSET:
                                    # Pitch exceeds threshold
                                    direction = 'down' if pitch_diff > 0 else 'up'
                                
                                logger.info(f"👀 Looking away detected: direction={direction}, yaw_diff={yaw_diff:.1f}°, pitch_diff={pitch_diff:.1f}°, yaw_offset={yaw_offset:.1f}°, pitch_offset={pitch_offset:.1f}°")
                            
                            # Track head pose for sustained violation
                            current_time = time.time()
                            head_pose_violation = self.track_head_pose(session_id, is_looking_away, direction, current_time)

                            if head_pose_violation:
                                logger.info(f"🚨 Looking away violation triggered: {head_pose_violation}")
                                result['violations'].append(head_pose_violation)
                                result['looking_away'] = True
                                cv2.putText(frame, f"HEAD TURNED AWAY! ({head_pose_violation['duration']:.1f}s)", (50, 150), 
                                          cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)
                            elif is_looking_away:
                                # Log that we're tracking but haven't reached duration threshold yet
                                tracking_data = self.head_pose_tracking.get(session_id, {})
                                if tracking_data:
                                    duration = current_time - tracking_data.get('start_time', current_time)
                                    frames = tracking_data.get('consecutive_frames', 0)
                                    logger.info(f"⏳ Tracking looking away: {duration:.1f}s / {self.HEAD_AWAY_DURATION_THRESHOLD_SEC}s, frames={frames}")
                    else:
                        logger.warning(f"⚠️ Head pose estimation returned None - could not estimate angles")
                else:
                    logger.warning(f"⚠️ No face landmarks detected - cannot estimate head pose")
            elif result['face_count'] > 1:
                logger.info(f"👥 Multiple faces detected ({result['face_count']}) - skipping head pose detection to reduce false positives")
            else:
                logger.info(f"👤 No face detected - skipping head pose detection")
            
            # Detect prohibited objects
            object_detection = self.detect_prohibited_objects(frame)
            result['phone_detected'] = object_detection['phone_detected']
            result['book_detected'] = object_detection['book_detected']
            
            if object_detection['phone_detected']:
                result['violations'].append({
                    'type': 'phone_detected',
                    'severity': 'high',
                    'message': 'Mobile phone detected'
                })
            
            if object_detection['book_detected']:
                result['violations'].append({
                    'type': 'book_detected',
                    'severity': 'medium',
                    'message': 'Book detected'
                })
            
            # If violations exist, capture snapshot (throttled per session)
            if result['violations']:
                now_ts = time.time()
                last_ts = self.last_snapshot_time_by_session.get(session_id, 0.0)
                if (now_ts - last_ts) >= self.SNAPSHOT_INTERVAL_SEC:
                    annotated_frame = object_detection['annotated_frame']
                    _, buffer = cv2.imencode('.jpg', annotated_frame)
                    result['snapshot_base64'] = base64.b64encode(buffer).decode('utf-8')
                    self.last_snapshot_time_by_session[session_id] = now_ts
            
            return result
            
        except Exception as e:
            return {'error': f'Frame processing error: {str(e)}'}

    def calibrate_from_frame(self, frame_base64: str) -> Optional[Tuple[float, float]]:
        """
        Extract calibration values (pitch, yaw) from a frame
        """
        try:
            # Decode base64 frame
            frame_data = base64.b64decode(frame_base64.split(',')[1] if ',' in frame_base64 else frame_base64)
            nparr = np.frombuffer(frame_data, np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            
            if frame is None:
                return None
            
            height, width, _ = frame.shape
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            
            face_mesh_results = self.mp_face_mesh.process(rgb_frame)
            if face_mesh_results.multi_face_landmarks:
                landmarks = face_mesh_results.multi_face_landmarks[0].landmark
                angles = self.estimate_head_pose(landmarks, width, height)
                
                if angles:
                    pitch, yaw, _ = angles
                    return (float(pitch), float(yaw))
            
            return None
        except Exception as e:
            print(f"Calibration error: {e}")
            return None

# Global instance
proctoring_service = ProctoringService()
