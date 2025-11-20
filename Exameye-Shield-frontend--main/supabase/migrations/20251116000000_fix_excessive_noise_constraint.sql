-- Fix violation constraint to include excessive_noise
ALTER TABLE public.violations
DROP CONSTRAINT IF EXISTS violations_violation_type_check;

ALTER TABLE public.violations
ADD CONSTRAINT violations_violation_type_check 
CHECK (violation_type IN (
  'looking_away',
  'no_person', 
  'phone_detected',
  'book_detected',
  'multiple_faces',
  'multiple_person',
  'object_detected',
  'tab_switch',
  'copy_paste',
  'excessive_noise',
  'audio_violation',
  'eye_movement',
  'window_blur'
));