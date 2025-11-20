"""
Test WebSocket violation detection end-to-end
Verifies that violations are properly sent and received via WebSocket
"""
import asyncio
import json
import base64
import cv2
import numpy as np
from websockets.client import connect
from datetime import datetime

async def test_websocket_violations():
    """Test WebSocket violation detection"""
    print("\n" + "="*60)
    print("WEBSOCKET VIOLATION DETECTION TEST")
    print("="*60)
    
    # Create test frame (bright empty frame for no_person detection)
    test_frame = np.zeros((480, 640, 3), dtype=np.uint8)
    test_frame[:] = (200, 200, 200)  # Bright gray
    _, buffer = cv2.imencode('.jpg', test_frame)
    frame_base64 = base64.b64encode(buffer).decode('utf-8')
    frame_data_url = f"data:image/jpeg;base64,{frame_base64}"
    
    session_id = f"test_session_{datetime.now().timestamp()}"
    ws_url = f"ws://localhost:8001/api/ws/proctoring/{session_id}"
    
    print(f"Connecting to: {ws_url}")
    print(f"Session ID: {session_id}")
    
    violations_received = []
    
    try:
        async with connect(ws_url) as websocket:
            print("[SUCCESS] WebSocket connected")
            
            # Send a test frame
            message = {
                "type": "frame",
                "frame": frame_data_url,
                "calibrated_pitch": 0.0,
                "calibrated_yaw": 0.0,
                "exam_id": "test_exam_id",
                "student_id": "test_student_id",
                "student_name": "Test Student",
                "subject_code": "TEST",
                "subject_name": "Test Subject"
            }
            
            print("\n📤 Sending test frame (should trigger no_person violation)...")
            await websocket.send(json.dumps(message))
            
            # Wait for response
            print("⏳ Waiting for response...")
            try:
                response = await asyncio.wait_for(websocket.recv(), timeout=10.0)
                data = json.loads(response)
                print(f"\n📥 Received response: {data.get('type')}")
                
                if data.get('type') == 'detection_result':
                    result = data.get('data', {})
                    print(f"   Face count: {result.get('face_count', 0)}")
                    print(f"   No person: {result.get('no_person', False)}")
                    print(f"   Violations: {len(result.get('violations', []))}")
                    
                    for v in result.get('violations', []):
                        print(f"   - {v.get('type')}: {v.get('message')}")
                        violations_received.append(v.get('type'))
                
                elif data.get('type') == 'violation':
                    violation = data.get('data', {})
                    print(f"   Violation type: {violation.get('type')}")
                    print(f"   Message: {violation.get('message')}")
                    violations_received.append(violation.get('type'))
                
                # Test browser activity violations
                print("\n📤 Testing browser activity violations...")
                
                # Test tab switch
                tab_switch_msg = {
                    "type": "browser_activity",
                    "violation_type": "tab_switch",
                    "message": "Tab switched - student navigated away from exam page",
                    "exam_id": "test_exam_id",
                    "student_id": "test_student_id",
                    "student_name": "Test Student",
                    "subject_code": "TEST",
                    "subject_name": "Test Subject"
                }
                await websocket.send(json.dumps(tab_switch_msg))
                print("   Sent tab_switch violation")
                
                # Wait for response
                response = await asyncio.wait_for(websocket.recv(), timeout=5.0)
                data = json.loads(response)
                if data.get('type') == 'violation':
                    violations_received.append(data.get('data', {}).get('type'))
                    print(f"   [SUCCESS] Received tab_switch violation response")
                
                # Test copy/paste
                copy_paste_msg = {
                    "type": "browser_activity",
                    "violation_type": "copy_paste",
                    "message": "Copy operation attempted",
                    "exam_id": "test_exam_id",
                    "student_id": "test_student_id",
                    "student_name": "Test Student",
                    "subject_code": "TEST",
                    "subject_name": "Test Subject"
                }
                await websocket.send(json.dumps(copy_paste_msg))
                print("   Sent copy_paste violation")
                
                # Wait for response
                response = await asyncio.wait_for(websocket.recv(), timeout=5.0)
                data = json.loads(response)
                if data.get('type') == 'violation':
                    violations_received.append(data.get('data', {}).get('type'))
                    print(f"   [SUCCESS] Received copy_paste violation response")
                
            except asyncio.TimeoutError:
                print("❌ Timeout waiting for response")
                return False
            
            print(f"\n📊 Violations received: {violations_received}")
            
            # Verify expected violations
            expected = ['no_person', 'tab_switch', 'copy_paste']
            missing = [v for v in expected if v not in violations_received]
            
            if not missing:
                print("\n[SUCCESS] PASS: All expected violations received")
                return True
            else:
                print(f"\n[FAIL] Missing violations: {missing}")
                return False
                
    except Exception as e:
        print(f"\n[ERROR] Error: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    result = asyncio.run(test_websocket_violations())
    exit(0 if result else 1)

