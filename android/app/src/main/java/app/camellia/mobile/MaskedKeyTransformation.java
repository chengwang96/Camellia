package app.camellia.mobile;

import android.text.method.PasswordTransformationMethod;
import android.view.View;

final class MaskedKeyTransformation extends PasswordTransformationMethod {
    @Override public CharSequence getTransformation(CharSequence source, View view) {
        return new CharSequence() {
            @Override public int length() { return source.length(); }
            @Override public char charAt(int index) { return source.charAt(index) == '\n' ? '\n' : '•'; }
            @Override public CharSequence subSequence(int start, int end) {
                StringBuilder masked = new StringBuilder();
                for (int index = start; index < end; index++) masked.append(charAt(index));
                return masked.toString();
            }
            @Override public String toString() { return subSequence(0, length()).toString(); }
        };
    }
}
