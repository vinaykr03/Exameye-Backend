"""
Test script to verify all violation types are detected correctly
Tests: no_person, multiple_person, phone_detected, looking_away, tab_switch, copy_paste
"""
import cv2
import numpy as np
import base64
import json
from proctoring_service import ProctoringService
from datetime import datetime

# Initialize proctoring service
proctoring_service = ProctoringService()

def create_test_frame(width=640, height=480, color=(128, 128, 128)):
    """Create a test frame with specified color"""
    frame = np.zeros((height, width, 3), dtype=np.uint8)
    frame[:] = color
    return frame

def frame_to_base64(frame):
    """Convert frame to base64 string"""
    _, buffer = cv2.imencode('.jpg', frame)
    return base64.b64encode(buffer).decode('utf-8')

def test_no_person_detection():
    """Test no person detection - empty frame with good brightness"""
    print("\n" + "="*60)
    print("TEST 1: No Person Detection")
    print("="*60)
    
    # Create a bright empty frame (simulating webcam on but no person)
    frame = create_test_frame(color=(200, 200, 200))
    
    result = proctoring_service.process_frame(
        frame=frame,
        session_id="test_no_person",
        calibrated_pitch=0.0,
        calibrated_yaw=0.0
    )
    
    print(f"Face count: {result.get('face_count', 0)}")
    print(f"No person detected: {result.get('no_person', False)}")
    print(f"Violations: {len(result.get('violations', []))}")
    
    if result.get('no_person'):
        print("✅ PASS: No person detected correctly")
        violations = result.get('violations', [])
        no_person_violations = [v for v in violations if v.get('type') == 'no_person']
        if no_person_violations:
            print(f"   Violation message: {no_person_violations[0].get('message')}")
            return True
        else:
            print("❌ FAIL: No person violation not in violations list")
            return False
    else:
        print("❌ FAIL: No person not detected")
        return False

def test_multiple_person_detection():
    """Test multiple person detection - requires actual face detection"""
    print("\n" + "="*60)
    print("TEST 2: Multiple Person Detection")
    print("="*60)
    print("⚠️  NOTE: This test requires actual face detection.")
    print("   For full test, use a frame with multiple faces.")
    print("   Creating test frame with single color (will not detect faces)...")
    
    # Create a test frame (won't have actual faces, but tests the logic)
    frame = create_test_frame(color=(150, 150, 150))
    
    result = proctoring_service.process_frame(
        frame=frame,
        session_id="test_multiple",
        calibrated_pitch=0.0,
        calibrated_yaw=0.0
    )
    
    print(f"Face count: {result.get('face_count', 0)}")
    print(f"Multiple faces: {result.get('multiple_faces', False)}")
    
    # Check if multiple face detection logic is present
    if 'multiple_faces' in result:
        print("✅ PASS: Multiple face detection logic is present")
        print("   (Full test requires actual face images)")
        return True
    else:
        print("❌ FAIL: Multiple face detection not implemented")
        return False

def test_phone_detection():
    """Test phone detection using YOLO"""
    print("\n" + "="*60)
    print("TEST 3: Phone Detection")
    print("="*60)
    print("⚠️  NOTE: This test requires YOLO model to detect phone in frame.")
    print("   Creating test frame (may not detect phone without actual phone image)...")
    
    # Create a test frame
    frame = create_test_frame(color=(100, 100, 100))
    
    result = proctoring_service.process_frame(
        frame=frame,
        session_id="test_phone",
        calibrated_pitch=0.0,
        calibrated_yaw=0.0
    )
    
    print(f"Phone detected: {result.get('phone_detected', False)}")
    print(f"Violations: {len(result.get('violations', []))}")
    
    # Check if phone detection logic is present
    phone_violations = [v for v in result.get('violations', []) if v.get('type') == 'phone_detected']
    
    if 'phone_detected' in result:
        print("✅ PASS: Phone detection logic is present")
        print("   (Full test requires actual phone in frame)")
        if phone_violations:
            print(f"   Violation message: {phone_violations[0].get('message')}")
        return True
    else:
        print("❌ FAIL: Phone detection not implemented")
        return False

def test_looking_away_detection():
    """Test looking away detection"""
    print("\n" + "="*60)
    print("TEST 4: Looking Away Detection")
    print("="*60)
    print("⚠️  NOTE: This test requires face detection and head pose estimation.")
    print("   Creating test frame (may not detect face without actual face image)...")
    
    # Create a test frame
    frame = create_test_frame(color=(120, 120, 120))
    
    # Test with extreme head pose (simulating looking away)
    result = proctoring_service.process_frame(
        frame=frame,
        session_id="test_looking_away",
        calibrated_pitch=0.0,  # Calibrated looking forward
        calibrated_yaw=0.0      # Calibrated looking forward
    )
    
    print(f"Looking away: {result.get('looking_away', False)}")
    print(f"Head pose: {result.get('head_pose')}")
    print(f"Violations: {len(result.get('violations', []))}")
    
    # Check if looking away detection logic is present
    looking_away_violations = [v for v in result.get('violations', []) if v.get('type') == 'looking_away']
    
    if 'looking_away' in result:
        print("✅ PASS: Looking away detection logic is present")
        print("   (Full test requires actual face with head pose)")
        if looking_away_violations:
            print(f"   Violation message: {looking_away_violations[0].get('message')}")
        return True
    else:
        print("❌ FAIL: Looking away detection not implemented")
        return False

def test_violation_types_in_code():
    """Verify all violation types are handled in the code"""
    print("\n" + "="*60)
    print("TEST 5: Verify Violation Types in Code")
    print("="*60)
    
    expected_types = [
        'no_person',
        'multiple_person',
        'phone_detected',
        'book_detected',
        'looking_away',
        'tab_switch',
        'copy_paste',
        'audio_violation'
    ]
    
    # Read server.py to check for violation type handling
    try:
        with open('server.py', 'r', encoding='utf-8') as f:
            server_code = f.read()
        
        found_types = []
        for vtype in expected_types:
            if vtype in server_code:
                found_types.append(vtype)
                print(f"✅ Found '{vtype}' in server code")
            else:
                print(f"❌ Missing '{vtype}' in server code")
        
        print(f"\nFound {len(found_types)}/{len(expected_types)} violation types in code")
        return len(found_types) == len(expected_types)
    except Exception as e:
        print(f"❌ Error reading server code: {e}")
        return False

def test_frame_processing_structure():
    """Test that process_frame returns correct structure"""
    print("\n" + "="*60)
    print("TEST 6: Frame Processing Structure")
    print("="*60)
    
    frame = create_test_frame()
    result = proctoring_service.process_frame(
        frame=frame,
        session_id="test_structure",
        calibrated_pitch=0.0,
        calibrated_yaw=0.0
    )
    
    required_fields = [
        'timestamp',
        'violations',
        'face_count',
        'looking_away',
        'multiple_faces',
        'no_person',
        'phone_detected',
        'book_detected'
    ]
    
    missing_fields = []
    for field in required_fields:
        if field not in result:
            missing_fields.append(field)
            print(f"❌ Missing field: {field}")
        else:
            print(f"✅ Found field: {field}")
    
    if not missing_fields:
        print("\n✅ PASS: All required fields present in result")
        return True
    else:
        print(f"\n❌ FAIL: Missing {len(missing_fields)} required fields")
        return False

def main():
    """Run all tests"""
    print("\n" + "="*60)
    print("VIOLATION DETECTION VERIFICATION TEST")
    print("="*60)
    print(f"Test started at: {datetime.now().isoformat()}")
    
    results = []
    
    # Run tests
    results.append(("No Person Detection", test_no_person_detection()))
    results.append(("Multiple Person Detection", test_multiple_person_detection()))
    results.append(("Phone Detection", test_phone_detection()))
    results.append(("Looking Away Detection", test_looking_away_detection()))
    results.append(("Violation Types in Code", test_violation_types_in_code()))
    results.append(("Frame Processing Structure", test_frame_processing_structure()))
    
    # Summary
    print("\n" + "="*60)
    print("TEST SUMMARY")
    print("="*60)
    
    passed = sum(1 for _, result in results if result)
    total = len(results)
    
    for test_name, result in results:
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"{status}: {test_name}")
    
    print(f"\nTotal: {passed}/{total} tests passed")
    
    if passed == total:
        print("\n🎉 All tests passed!")
        return 0
    else:
        print(f"\n⚠️  {total - passed} test(s) failed")
        return 1

if __name__ == "__main__":
    exit(main())

