package backend

import (
	"bytes"
	"encoding/binary"
)

// Reject exact digital silence in the canonical device WAV. This does not
// estimate speech or apply an uncalibrated amplitude threshold to the mic.
func passportWavIsDigitalSilence(wav []byte) bool {
	if len(wav) < 46 || (len(wav)-44)%2 != 0 ||
		!bytes.Equal(wav[:4], []byte("RIFF")) || !bytes.Equal(wav[8:16], []byte("WAVEfmt ")) ||
		!bytes.Equal(wav[36:40], []byte("data")) ||
		binary.LittleEndian.Uint32(wav[4:8]) != uint32(len(wav)-8) ||
		binary.LittleEndian.Uint32(wav[16:20]) != 16 ||
		binary.LittleEndian.Uint16(wav[20:22]) != 1 ||
		binary.LittleEndian.Uint16(wav[22:24]) != 1 ||
		binary.LittleEndian.Uint32(wav[24:28]) != 16000 ||
		binary.LittleEndian.Uint32(wav[28:32]) != 32000 ||
		binary.LittleEndian.Uint16(wav[32:34]) != 2 ||
		binary.LittleEndian.Uint16(wav[34:36]) != 16 ||
		binary.LittleEndian.Uint32(wav[40:44]) != uint32(len(wav)-44) {
		return false
	}
	for _, sampleByte := range wav[44:] {
		if sampleByte != 0 {
			return false
		}
	}
	return true
}
