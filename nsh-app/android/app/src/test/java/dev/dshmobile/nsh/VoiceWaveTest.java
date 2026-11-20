package dev.dshmobile.nsh;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.junit.Test;

public class VoiceWaveTest {
    @Test public void canonicalHeaderAndSamplesMatchRc5() {
        byte[] pcm = { 0, 0, -1, 127, 0, -128 };
        byte[] wav = Voice.wave(pcm);
        ByteBuffer b = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        assertEquals("RIFF", new String(wav, 0, 4, StandardCharsets.US_ASCII));
        assertEquals(wav.length - 8, b.getInt(4));
        assertEquals("WAVEfmt ", new String(wav, 8, 8, StandardCharsets.US_ASCII));
        assertEquals(16, b.getInt(16)); assertEquals(1, b.getShort(20)); assertEquals(1, b.getShort(22));
        assertEquals(16000, b.getInt(24)); assertEquals(32000, b.getInt(28));
        assertEquals(2, b.getShort(32)); assertEquals(16, b.getShort(34));
        assertEquals("data", new String(wav, 36, 4, StandardCharsets.US_ASCII));
        assertEquals(pcm.length, b.getInt(40));
        assertArrayEquals(pcm, Arrays.copyOfRange(wav, 44, wav.length));
    }
    @Test public void maximumPhoneRecordingHasNoExtraChunks() {
        byte[] wav = Voice.wave(new byte[60 * 32000]);
        assertEquals(1920044, wav.length);
        assertEquals(1920000, ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).getInt(40));
    }
}
