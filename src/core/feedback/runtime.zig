const std = @import("std");

pub const url = "https://chassis.sh/feedback";

test "feedback URL stays on the chassis.sh domain" {
    try std.testing.expectEqualStrings("https://chassis.sh/feedback", url);
}
