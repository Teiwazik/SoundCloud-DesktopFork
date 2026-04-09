#include "soundtouch-2_3_2/include/BPMDetect.h"
#include "soundtouch-2_3_2/include/FIFOSampleBuffer.h"
#include "soundtouch-2_3_2/include/FIFOSamplePipe.h"
#include "soundtouch-2_3_2/include/STTypes.h"
#include "soundtouch-2_3_2/include/SoundTouch.h"
#include "soundtouch-2_3_2/include/soundtouch_config.h"

// Wrapper functions for virtual methods inherited from FIFOProcessor
// These are needed because bindgen doesn't generate bindings for inherited virtual methods
#ifdef SOUNDTOUCH_WRAPPER_IMPLEMENTATION
extern "C" {
    unsigned int soundtouch_numSamples(soundtouch::SoundTouch* st) {
        return st->numSamples();
    }
    int soundtouch_isEmpty(soundtouch::SoundTouch* st) {
        return st->isEmpty();
    }
}
#else
extern "C" {
    unsigned int soundtouch_numSamples(soundtouch::SoundTouch* st);
    int soundtouch_isEmpty(soundtouch::SoundTouch* st);
}
#endif
