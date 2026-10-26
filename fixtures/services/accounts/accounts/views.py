from django.db import transaction
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.views import APIView
from .models import Profile
from .notify import notify_changed


@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
@transaction.atomic
def profile_detail(request, user_id):
    profile = Profile.objects.get(user_id=user_id)
    if request.method == "POST":
        profile.bio = request.data["bio"]
        profile.save()
        transaction.on_commit(lambda: notify_changed(user_id))
    return profile


def delete_profile(request, profile_id):
    Profile.objects.filter(id=profile_id).delete()


class ProfileList(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return list(Profile.objects.all())
